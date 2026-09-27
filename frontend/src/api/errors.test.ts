import { AxiosError, AxiosHeaders } from 'axios'
import { describe, expect, it } from 'vitest'

import { normalizeApiError } from './errors'

describe('normalizeApiError', () => {
  it('classifies backend validation errors', () => {
    const error = axiosError(400, { statusCode: 400, message: 'Invalid request' })

    expect(normalizeApiError(error)).toEqual(
      expect.objectContaining({
        kind: 'validation',
        status: 400,
        message: 'Invalid request',
      }),
    )
  })

  it('classifies the short rate-limit response and keeps Retry-After', () => {
    const error = axiosError(429, { statusCode: 429, message: 'Too many requests' }, '30')

    expect(normalizeApiError(error)).toEqual(
      expect.objectContaining({
        kind: 'rate-limit',
        status: 429,
        retryAfter: '30',
      }),
    )
  })

  it('classifies requests without a response as network failures', () => {
    expect(normalizeApiError(new AxiosError('offline'))).toEqual(
      expect.objectContaining({ kind: 'network' }),
    )
  })
})

function axiosError(status: number, data: unknown, retryAfter?: string) {
  const headers = new AxiosHeaders()
  if (retryAfter) headers.set('retry-after', retryAfter)

  return new AxiosError('request failed', undefined, undefined, undefined, {
    status,
    statusText: 'Error',
    headers,
    config: { headers: new AxiosHeaders() },
    data,
  })
}
