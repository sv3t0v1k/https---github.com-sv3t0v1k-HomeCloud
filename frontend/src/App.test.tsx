import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { apiClient, sessionClient } from './api/client'
import { SessionProvider } from './auth/SessionContext'
import { publishSessionExpired } from './auth/sessionEvents'
import { tokenStorage } from './auth/tokenStorage'

describe('authentication UX', () => {
  beforeEach(() => tokenStorage.clear())
  afterEach(cleanup)

  it('signs in through the real contract and opens the protected area', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/auth/login') {
        expect(JSON.parse(String(config.data))).toEqual({
          email: 'owner@example.com',
          password: 'correct-password',
        })
        return response(config, {
          success: true,
          data: { accessToken: 'access', refreshToken: 'refresh' },
        })
      }
      if (config.url === '/users/me') return userResponse(config)
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(await screen.findByText('My Files')).toBeInTheDocument()
    expect(tokenStorage.getRefreshToken()).toBe('refresh')
  })

  it('shows invalid credentials without creating a session', async () => {
    apiClient.defaults.adapter = async (config) => {
      throw responseError(config, 401, 'Invalid credentials')
    }

    renderApp('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials')
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })

  it('clears newly issued tokens when loading the user fails', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/auth/login') {
        return response(config, {
          success: true,
          data: { accessToken: 'access', refreshToken: 'refresh' },
        })
      }
      if (config.url === '/users/me') throw new AxiosError('offline')
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('server is unavailable')
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })

  it('revokes the rotated refresh session before clearing local state', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'initial-refresh' })
    let refreshCount = 0
    sessionClient.defaults.adapter = async (config) => {
      refreshCount += 1
      return response(config, {
        success: true,
        data: {
          accessToken: `access-${refreshCount}`,
          refreshToken: `refresh-${refreshCount}`,
        },
      })
    }
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/users/me') return userResponse(config)
      if (config.url === '/auth/logout') {
        expect(config.headers.Authorization).toBe('Bearer access-2')
        expect(JSON.parse(String(config.data))).toEqual({ refreshToken: 'refresh-2' })
        return response(config, { success: true, data: { message: 'Logged out' } })
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Logout' }))

    expect(await screen.findByRole('heading', { name: 'Sign In' })).toBeInTheDocument()
    expect(refreshCount).toBe(2)
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })

  it('keeps the session when server logout is temporarily unavailable', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'initial-refresh' })
    let refreshCount = 0
    sessionClient.defaults.adapter = async (config) => {
      refreshCount += 1
      return response(config, {
        success: true,
        data: {
          accessToken: `access-${refreshCount}`,
          refreshToken: `refresh-${refreshCount}`,
        },
      })
    }
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/users/me') return userResponse(config)
      if (config.url === '/auth/logout') throw new AxiosError('offline')
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Logout' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('server is unavailable')
    expect(screen.getByText('My Files')).toBeInTheDocument()
    expect(tokenStorage.getRefreshToken()).toBe('refresh-2')
  })

  it('redirects an expired session with a meaningful notice', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'initial-refresh' })
    sessionClient.defaults.adapter = async (config) => response(config, {
      success: true,
      data: { accessToken: 'access', refreshToken: 'refresh' },
    })
    apiClient.defaults.adapter = async (config) => userResponse(config)

    renderApp('/files')
    expect(await screen.findByText('My Files')).toBeInTheDocument()

    act(() => publishSessionExpired())

    expect(await screen.findByRole('status')).toHaveTextContent('session has expired')
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument()
  })
})

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  )
}

function userResponse(config: InternalAxiosRequestConfig) {
  return response(config, {
    success: true,
    data: {
      id: 1,
      email: 'owner@example.com',
      name: 'Owner',
      isActive: true,
      isEmailVerified: true,
      avatar: null,
      storageQuota: '1000',
      storageUsed: '0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
}

function response(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    config,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    data,
  }
}

function responseError(
  config: InternalAxiosRequestConfig,
  status: number,
  message: string,
) {
  return new AxiosError('request failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers: new AxiosHeaders(),
    data: { statusCode: status, message },
  })
}
