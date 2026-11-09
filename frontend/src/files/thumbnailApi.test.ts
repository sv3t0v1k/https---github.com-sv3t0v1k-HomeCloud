import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'

import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'
import { fetchFileThumbnail } from './thumbnailApi'

function response(
  config: InternalAxiosRequestConfig,
  data: unknown,
): AxiosResponse {
  return {
    config,
    data,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
  }
}

afterEach(() => {
  apiClient.defaults.adapter = undefined
  tokenStorage.clear()
  vi.restoreAllMocks()
})

describe('thumbnail API', () => {
  it('uses authenticated binary response without URL tokens', async () => {
    tokenStorage.set({
      accessToken: 'owner-secret',
      refreshToken: 'refresh-secret',
    })

    let request: InternalAxiosRequestConfig | undefined

    apiClient.defaults.adapter = async (config) => {
      request = config
      return response(
        config,
        new Blob(['png-bytes'], { type: 'image/png' }),
      )
    }

    const blob = await fetchFileThumbnail(42)

    expect(blob.type).toBe('image/png')
    expect(request?.url).toBe('/previews/42/thumbnail')
    expect(request?.method).toBe('get')
    expect(request?.responseType).toBe('blob')
    expect(request?.headers.Authorization).toBe(
      'Bearer owner-secret',
    )
    expect(request?.url).not.toContain('secret')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid file ID %s',
    async (id) => {
      await expect(fetchFileThumbnail(id)).rejects.toThrow(
        RangeError,
      )
    },
  )

  it('rejects invalid and oversized binary responses', async () => {
    for (const body of [
      { success: true, data: 'unexpected JSON' },
      new Blob([], { type: 'image/png' }),
      new Blob(['wrong type'], { type: 'text/html' }),
      new Blob(
        [new Uint8Array(2 * 1024 * 1024 + 1)],
        { type: 'image/png' },
      ),
    ]) {
      apiClient.defaults.adapter = async (config) =>
        response(config, body)

      await expect(fetchFileThumbnail(7)).rejects.toThrow(
        'Invalid thumbnail response',
      )
    }
  })

  it('rejects a response after the authenticated owner changes', async () => {
    tokenStorage.set({
      accessToken: 'first-owner',
      refreshToken: 'first-refresh',
    })

    let finish!: () => void
    let started!: () => void

    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })

    apiClient.defaults.adapter = async (config) => {
      started()
      return await new Promise<AxiosResponse>((resolve) => {
        finish = () => resolve(
          response(
            config,
            new Blob(['private-png'], { type: 'image/png' }),
          ),
        )
      })
    }

    const pending = fetchFileThumbnail(42)
    await startedPromise

    tokenStorage.clear()
    tokenStorage.set({
      accessToken: 'second-owner',
      refreshToken: 'second-refresh',
    })

    finish()

    await expect(pending).rejects.toThrow('old session')
  })
})
