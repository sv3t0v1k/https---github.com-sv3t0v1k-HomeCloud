import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { apiClient, sessionClient } from './api/client'
import { SessionProvider } from './auth/SessionContext'
import { publishSessionExpired } from './auth/sessionEvents'
import { tokenStorage } from './auth/tokenStorage'

describe('authentication UX', () => {
  it('mounts the drawer only when open, traps focus, closes on Escape and restores the opener', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'refresh' })
    sessionClient.defaults.adapter = async (config) => response(config, { success: true, data: { accessToken: 'access', refreshToken: 'rotated' } })
    apiClient.defaults.adapter = async (config) => isDirectoryRequest(config.url) ? emptyDirectoryResponse(config) : userResponse(config)
    renderApp('/files')
    const user = userEvent.setup()
    const opener = await screen.findByRole('button', { name: 'Открыть навигацию' })
    expect(opener).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog', { name: 'Навигация' })).not.toBeInTheDocument()
    await user.click(opener)
    const drawer = screen.getByRole('dialog', { name: 'Навигация' })
    expect(opener).toHaveAttribute('aria-controls', drawer.id)
    expect(opener).toHaveAttribute('aria-expanded', 'true')
    expect(drawer).toContainElement(document.activeElement as HTMLElement)
    expect(document.querySelector<HTMLElement>('.app-frame')?.inert).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    await user.tab({ shift: true })
    expect(drawer).toContainElement(document.activeElement as HTMLElement)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Закрыть навигацию' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Навигация' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    expect(opener).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector<HTMLElement>('.app-frame')?.inert).toBe(false)
    expect(document.body.style.overflow).toBe('')
    vi.unstubAllGlobals()
  })

  it('opens profile, quota and password fields from the visible account navigation', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'refresh' })
    sessionClient.defaults.adapter = async (config) => response(config, { success: true, data: { accessToken: 'access', refreshToken: 'rotated' } })
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/storage-info') return response(config, { success: true, data: { storageUsed: '25', storageQuota: '1000', fileCount: 1, folderCount: 0 } })
      return isDirectoryRequest(config.url) ? emptyDirectoryResponse(config) : userResponse(config)
    }
    renderApp('/files')
    const user = userEvent.setup()
    const account = await screen.findByRole('button', { name: 'Аккаунт' })
    await user.click(account)
    expect(screen.getByRole('dialog', { name: 'Аккаунт и хранилище' })).toBeInTheDocument()
    expect(await screen.findByText(/Использовано 25 байт/)).toBeInTheDocument()
    expect(screen.getByLabelText('Имя')).toBeInTheDocument()
    expect(screen.getByLabelText('Текущий пароль')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByLabelText('Новый пароль')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Повторите новый пароль')).toHaveAttribute('autocomplete', 'new-password')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Аккаунт и хранилище' })).not.toBeInTheDocument()
    expect(account).toHaveFocus()
  })

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
      if (isDirectoryRequest(config.url)) return emptyDirectoryResponse(config)
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Электронная почта'), 'owner@example.com')
    await user.type(screen.getByLabelText('Пароль'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('heading', { name: 'Мои файлы' })).toBeInTheDocument()
    expect(tokenStorage.getRefreshToken()).toBe('refresh')
  })

  it('shows invalid credentials without creating a session', async () => {
    apiClient.defaults.adapter = async (config) => {
      throw responseError(config, 401, 'Invalid credentials')
    }

    renderApp('/login')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Электронная почта'), 'owner@example.com')
    await user.type(screen.getByLabelText('Пароль'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверная электронная почта или пароль.')
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
    await user.type(await screen.findByLabelText('Электронная почта'), 'owner@example.com')
    await user.type(screen.getByLabelText('Пароль'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен')
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
      if (isDirectoryRequest(config.url)) return emptyDirectoryResponse(config)
      if (config.url === '/auth/logout') {
        expect(config.headers.Authorization).toBe('Bearer access-2')
        expect(JSON.parse(String(config.data))).toEqual({ refreshToken: 'refresh-2' })
        return response(config, { success: true, data: { message: 'Logged out' } })
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Выйти' }))

    expect(await screen.findByRole('heading', { name: 'Войти' })).toBeInTheDocument()
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
      if (isDirectoryRequest(config.url)) return emptyDirectoryResponse(config)
      if (config.url === '/auth/logout') throw new AxiosError('offline')
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Выйти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен')
    expect(screen.getByRole('heading', { name: 'Мои файлы' })).toBeInTheDocument()
    expect(tokenStorage.getRefreshToken()).toBe('refresh-2')
  })

  it('redirects an expired session with a meaningful notice', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'initial-refresh' })
    sessionClient.defaults.adapter = async (config) => response(config, {
      success: true,
      data: { accessToken: 'access', refreshToken: 'refresh' },
    })
    apiClient.defaults.adapter = async (config) =>
      isDirectoryRequest(config.url) ? emptyDirectoryResponse(config) : userResponse(config)

    renderApp('/files')
    expect(await screen.findByRole('heading', { name: 'Мои файлы' })).toBeInTheDocument()

    act(() => publishSessionExpired())

    expect(await screen.findByRole('status')).toHaveTextContent('Сессия истекла')
    expect(screen.getByRole('heading', { name: 'Войти' })).toBeInTheDocument()
  })

  it('routes a terminal 401 from a file mutation through session expiry handling', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'initial-refresh' })
    let refreshCalls = 0
    sessionClient.defaults.adapter = async (config) => {
      refreshCalls += 1
      if (refreshCalls === 1) {
        return response(config, {
          success: true,
          data: { accessToken: 'access', refreshToken: 'rotated-refresh' },
        })
      }
      throw responseError(config, 401, 'Refresh token expired')
    }
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/users/me') return userResponse(config)
      if (config.url === '/files/folders' && config.method === 'post') {
        throw responseError(config, 401, 'Access token expired')
      }
      if (isDirectoryRequest(config.url)) return emptyDirectoryResponse(config)
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderApp('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Новая папка' }))
    await user.type(await screen.findByLabelText('Название папки'), 'New folder')
    await user.click(screen.getByRole('button', { name: 'Создать папку' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Сессия истекла')
    expect(screen.getByRole('heading', { name: 'Войти' })).toBeInTheDocument()
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(refreshCalls).toBe(2)
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

function isDirectoryRequest(url?: string) {
  return url === '/files' || url === '/files/folders'
}

function emptyDirectoryResponse(config: InternalAxiosRequestConfig) {
  return response(config, { success: true, data: [] })
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
