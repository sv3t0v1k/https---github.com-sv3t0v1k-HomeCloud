import axios, { AxiosHeaders } from 'axios'

import type { BackendErrorBody } from './contracts'

export type ApiErrorKind =
  | 'network'
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'server'
  | 'unknown'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly retryAfter?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  if (!axios.isAxiosError<BackendErrorBody>(error)) {
    return new ApiError('Unexpected application error', 'unknown')
  }

  if (!error.response) {
    return new ApiError('The server is unavailable', 'network')
  }

  const status = error.response.status
  const backendMessage = error.response.data?.message
  const message = backendMessage || defaultMessage(status)
  const headers = error.response.headers
  const retryAfterHeader = headers instanceof AxiosHeaders
    ? headers.get('retry-after')
    : Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
  const retryAfter = typeof retryAfterHeader === 'string' || typeof retryAfterHeader === 'number'
    ? String(retryAfterHeader)
    : undefined

  if (status === 400 || status === 422) return new ApiError(message, 'validation', status)
  if (status === 401) return new ApiError(message, 'authentication', status)
  if (status === 403) return new ApiError(message, 'authorization', status)
  if (status === 429) return new ApiError(message, 'rate-limit', status, retryAfter)
  if (status >= 500) return new ApiError(message, 'server', status)
  return new ApiError(message, 'unknown', status)
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session has expired'
  if (status === 403) return 'You do not have access to this resource'
  if (status === 429) return 'Too many requests'
  if (status >= 500) return 'The server could not complete the request'
  return 'The request could not be completed'
}
