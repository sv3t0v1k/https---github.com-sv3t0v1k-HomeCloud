import { render, screen, waitFor } from '@testing-library/react'
import { AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { apiClient, sessionClient } from '../api/client'
import { SessionProvider } from '../auth/SessionContext'
import { tokenStorage } from '../auth/tokenStorage'
import { ProtectedRoute } from './ProtectedRoute'

describe('ProtectedRoute', () => {
  beforeEach(() => tokenStorage.clear())

  it('redirects an anonymous visitor to login', async () => {
    renderRoutes()

    expect(await screen.findByText('Login screen')).toBeInTheDocument()
    expect(screen.queryByText('Protected screen')).not.toBeInTheDocument()
  })

  it('waits for bootstrap and then renders the protected route', async () => {
    tokenStorage.set({ accessToken: 'stale', refreshToken: 'refresh' })
    let finishRefresh: (() => void) | undefined
    sessionClient.defaults.adapter = (config) =>
      new Promise((resolve) => {
        finishRefresh = () => resolve(response(config, {
          success: true,
          data: { accessToken: 'fresh', refreshToken: 'rotated' },
        }))
      })
    apiClient.defaults.adapter = async (config) => response(config, {
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

    renderRoutes()

    expect(screen.getByRole('status')).toHaveTextContent('Восстанавливаем сеанс')
    expect(screen.queryByText('Protected screen')).not.toBeInTheDocument()
    finishRefresh?.()

    await waitFor(() => expect(screen.getByText('Protected screen')).toBeInTheDocument())
  })
})

function renderRoutes() {
  return render(
    <MemoryRouter initialEntries={['/files']}>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<div>Login screen</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/files" element={<div>Protected screen</div>} />
          </Route>
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  )
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
