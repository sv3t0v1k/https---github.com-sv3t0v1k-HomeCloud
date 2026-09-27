import axios, {
  type AxiosError,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'

import { publishSessionExpired } from '../auth/sessionEvents'
import { tokenStorage } from '../auth/tokenStorage'
import type { Tokens } from '../types/auth'
import type { ApiEnvelope } from './contracts'
import { normalizeApiError } from './errors'

declare module 'axios' {
  interface AxiosRequestConfig {
    skipAuth?: boolean
    skipRefresh?: boolean
    authRetry?: boolean
    accessTokenUsed?: string
  }

  interface InternalAxiosRequestConfig {
    skipAuth?: boolean
    skipRefresh?: boolean
    authRetry?: boolean
    accessTokenUsed?: string
  }
}

export const API_BASE_URL = import.meta.env.VITE_API_URL?.trim() || '/api/v1'

export const apiClient = axios.create({ baseURL: API_BASE_URL })
export const sessionClient = axios.create({ baseURL: API_BASE_URL })

let refreshPromise: Promise<Tokens> | null = null

apiClient.interceptors.request.use((config) => {
  if (config.skipAuth) return config

  const accessToken = tokenStorage.getAccessToken()
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
    config.accessTokenUsed = accessToken
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config
    if (!config || error.response?.status !== 401 || !isRefreshEligible(config)) {
      return Promise.reject(error)
    }

    if (config.authRetry) {
      expireSession()
      return Promise.reject(error)
    }

    const currentAccessToken = tokenStorage.getAccessToken()
    if (
      config.accessTokenUsed &&
      currentAccessToken &&
      config.accessTokenUsed !== currentAccessToken
    ) {
      return retryWithCurrentToken(config, currentAccessToken)
    }

    if (!tokenStorage.getRefreshToken()) {
      expireSession()
      return Promise.reject(error)
    }

    try {
      const tokens = await refreshSession()
      return retryWithCurrentToken(config, tokens.accessToken)
    } catch (refreshError) {
      return Promise.reject(refreshError)
    }
  },
)

export async function apiRequest<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await apiClient.request<ApiEnvelope<T>>(config)
    return response.data.data
  } catch (error) {
    throw normalizeApiError(error)
  }
}

export function refreshSession(): Promise<Tokens> {
  if (refreshPromise) return refreshPromise

  const refreshToken = tokenStorage.getRefreshToken()
  if (!refreshToken) {
    expireSession()
    return Promise.reject(new Error('No refresh token'))
  }
  const refreshEpoch = tokenStorage.getEpoch()

  refreshPromise = sessionClient
    .post<ApiEnvelope<Tokens>>('/auth/refresh', { refreshToken })
    .then((response) => {
      const tokens = response.data.data
      if (!tokenStorage.setIfCurrent(tokens, refreshEpoch)) {
        throw new Error('The session changed while refresh was in progress')
      }
      return tokens
    })
    .catch((error: AxiosError) => {
      if (error.response?.status === 400 || error.response?.status === 401) {
        expireSession()
      }
      throw error
    })
    .finally(() => {
      refreshPromise = null
    })

  return refreshPromise
}

export function clearSession() {
  tokenStorage.clear()
}

function retryWithCurrentToken(
  config: InternalAxiosRequestConfig,
  accessToken: string,
) {
  config.authRetry = true
  config.accessTokenUsed = accessToken
  config.headers.Authorization = `Bearer ${accessToken}`
  return apiClient.request(config)
}

function isRefreshEligible(config: InternalAxiosRequestConfig): boolean {
  if (config.skipAuth || config.skipRefresh) return false
  const url = config.url || ''
  return !['/auth/login', '/auth/register', '/auth/refresh'].some((path) =>
    url.endsWith(path),
  )
}

function expireSession() {
  tokenStorage.clear()
  publishSessionExpired()
}
