import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { beforeEach, describe, expect, it } from 'vitest'

import { tokenStorage } from '../auth/tokenStorage'
import {
  API_BASE_URL,
  apiClient,
  apiRequest,
  clearSession,
  refreshSession,
  sessionClient,
} from './client'

describe('API client', () => {
  beforeEach(() => {
    tokenStorage.clear()
  })

  it('uses the same-origin API prefix by default', () => {
    expect(API_BASE_URL).toBe('/api/v1')
  })

  it('unwraps the backend success envelope', async () => {
    apiClient.defaults.adapter = async (config) => response(config, 200, {
      success: true,
      data: { id: 7 },
    })

    await expect(apiRequest<{ id: number }>({ url: '/resource' })).resolves.toEqual({ id: 7 })
  })

  it('performs one refresh for concurrent 401 responses and retries once', async () => {
    tokenStorage.set({ accessToken: 'old-access', refreshToken: 'old-refresh' })
    let refreshCalls = 0
    let protectedCalls = 0

    sessionClient.defaults.adapter = async (config) => {
      refreshCalls += 1
      expect(JSON.parse(String(config.data))).toEqual({ refreshToken: 'old-refresh' })
      return response(config, 200, {
        success: true,
        data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
      })
    }
    apiClient.defaults.adapter = async (config) => {
      protectedCalls += 1
      if (config.headers.Authorization === 'Bearer old-access') {
        throw responseError(config, 401)
      }
      expect(config.headers.Authorization).toBe('Bearer new-access')
      return response(config, 200, { success: true, data: 'ok' })
    }

    await expect(
      Promise.all([
        apiRequest<string>({ url: '/one' }),
        apiRequest<string>({ url: '/two' }),
        apiRequest<string>({ url: '/three' }),
      ]),
    ).resolves.toEqual(['ok', 'ok', 'ok'])

    expect(refreshCalls).toBe(1)
    expect(protectedCalls).toBe(6)
    expect(tokenStorage.getRefreshToken()).toBe('new-refresh')
  })

  it('clears the session after a terminal refresh 401 without recursion', async () => {
    tokenStorage.set({ accessToken: 'old-access', refreshToken: 'invalid-refresh' })
    let refreshCalls = 0

    sessionClient.defaults.adapter = async (config) => {
      refreshCalls += 1
      throw responseError(config, 401)
    }
    apiClient.defaults.adapter = async (config) => {
      throw responseError(config, 401)
    }

    await expect(apiRequest({ url: '/protected' })).rejects.toMatchObject({
      kind: 'authentication',
    })
    expect(refreshCalls).toBe(1)
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })

  it('does not refresh public authentication failures', async () => {
    tokenStorage.set({ accessToken: 'old-access', refreshToken: 'refresh' })
    let refreshCalls = 0
    sessionClient.defaults.adapter = async (config) => {
      refreshCalls += 1
      return response(config, 200, {})
    }
    apiClient.defaults.adapter = async (config) => {
      throw responseError(config, 401)
    }

    await expect(apiRequest({ url: '/auth/login', method: 'POST' })).rejects.toMatchObject({
      kind: 'authentication',
    })
    expect(refreshCalls).toBe(0)
  })

  it('retains the refresh token when refresh is temporarily unavailable', async () => {
    tokenStorage.set({ accessToken: 'old-access', refreshToken: 'keep-refresh' })
    sessionClient.defaults.adapter = async () => {
      throw new AxiosError('offline')
    }
    apiClient.defaults.adapter = async (config) => {
      throw responseError(config, 401)
    }

    await expect(apiRequest({ url: '/protected' })).rejects.toMatchObject({ kind: 'network' })
    expect(tokenStorage.getRefreshToken()).toBe('keep-refresh')
  })

  it('never retries an old owner request with a different login token', async () => {
    tokenStorage.set({ accessToken: 'owner-a', refreshToken: 'refresh-a' })
    let finish!: () => void
    let calls = 0
    apiClient.defaults.adapter = (config) => {
      calls++
      return new Promise((_resolve, reject) => { finish = () => reject(responseError(config, 401)) })
    }
    const pending = apiRequest({ url: '/uploads/session', method: 'POST', data: { filename: 'owner-a.bin' } })
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'authentication' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    clearSession()
    tokenStorage.set({ accessToken: 'owner-b', refreshToken: 'refresh-b' })
    finish()
    await rejected
    expect(calls).toBe(1)
    expect(tokenStorage.getAccessToken()).toBe('owner-b')
  })

  it('captures the owner boundary before asynchronous request interceptors run', async () => {
    tokenStorage.set({ accessToken: 'owner-a', refreshToken: 'refresh-a' })
    let calls = 0
    apiClient.defaults.adapter = async (config) => { calls++; return response(config, 200, { success: true, data: {} }) }
    const pending = apiRequest({ url: '/uploads/session', method: 'POST' })
    clearSession()
    tokenStorage.set({ accessToken: 'owner-b', refreshToken: 'refresh-b' })
    await expect(pending).rejects.toMatchObject({ kind: 'authentication' })
    expect(calls).toBe(0)
    expect(tokenStorage.getAccessToken()).toBe('owner-b')
  })

  it('does not clear a new login when an old refresh fails late', async () => {
    tokenStorage.set({ accessToken: 'owner-a', refreshToken: 'refresh-a' })
    let finish!: () => void
    sessionClient.defaults.adapter = (config) => new Promise((_resolve, reject) => { finish = () => reject(responseError(config, 401)) })
    const pending = refreshSession()
    const rejected = expect(pending).rejects.toBeDefined()
    clearSession()
    tokenStorage.set({ accessToken: 'owner-b', refreshToken: 'refresh-b' })
    finish()
    await rejected
    expect(tokenStorage.getAccessToken()).toBe('owner-b')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-b')
  })

  it('does not restore tokens when the session is cleared during refresh', async () => {
    tokenStorage.set({ accessToken: 'old-access', refreshToken: 'old-refresh' })
    let finishRefresh: (() => void) | undefined
    sessionClient.defaults.adapter = (config) =>
      new Promise((resolve) => {
        finishRefresh = () => resolve(response(config, 200, {
          success: true,
          data: { accessToken: 'late-access', refreshToken: 'late-refresh' },
        }))
      })

    const pendingRefresh = refreshSession()
    clearSession()
    finishRefresh?.()

    await expect(pendingRefresh).rejects.toThrow('session changed')
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })
})

function response(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse {
  return {
    config,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new AxiosHeaders(),
    data,
  }
}

function responseError(config: InternalAxiosRequestConfig, status: number) {
  return new AxiosError('request failed', undefined, config, undefined, response(config, status, {
    statusCode: status,
    message: status === 401 ? 'Unauthorized' : 'Request failed',
  }))
}
