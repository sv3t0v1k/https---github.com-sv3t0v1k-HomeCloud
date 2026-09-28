import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '../api/client'
import { ApiError } from '../api/errors'
import { tokenStorage } from '../auth/tokenStorage'
import {
  BrowserDownloadLimitError,
  downloadOriginalFile,
  MAX_BROWSER_BLOB_DOWNLOAD_BYTES,
} from './download'

describe('downloadOriginalFile', () => {
  beforeEach(() => {
    tokenStorage.clear()
    apiClient.defaults.adapter = undefined
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:homecloud-download'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    tokenStorage.clear()
    apiClient.defaults.adapter = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('downloads the exact authenticated original endpoint and cleans up the object URL', async () => {
    tokenStorage.set({ accessToken: 'access-token', refreshToken: 'refresh-token' })
    const blob = new Blob(['original bytes'], { type: 'text/plain' })
    let request: InternalAxiosRequestConfig | undefined
    apiClient.defaults.adapter = async (config) => {
      request = config
      return ok(config, blob)
    }
    let clickedHref: string | undefined
    let clickedDownload: string | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedHref = this.href
      clickedDownload = this.download
    })

    await downloadOriginalFile({ id: 42, name: 'отчёт.txt', size: blob.size })

    expect(request?.method).toBe('get')
    expect(request?.url).toBe('/files/42/download')
    expect(request?.responseType).toBe('blob')
    expect(request?.headers.Authorization).toBe('Bearer access-token')
    expect(clickedHref).toBe('blob:homecloud-download')
    expect(clickedDownload).toBe('отчёт.txt')
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:homecloud-download')
    expect(document.querySelector('a[href="blob:homecloud-download"]')).toBeNull()
  })

  it('rejects an oversized file before making a request', async () => {
    const adapter = vi.fn()
    apiClient.defaults.adapter = adapter

    await expect(
      downloadOriginalFile({
        id: 42,
        name: 'large.bin',
        size: String(MAX_BROWSER_BLOB_DOWNLOAD_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(BrowserDownloadLimitError)

    expect(adapter).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('accepts the exact browser-safe cap', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, new Blob())
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await expect(
      downloadOriginalFile({
        id: 7,
        name: 'at-limit.bin',
        size: MAX_BROWSER_BLOB_DOWNLOAD_BYTES,
      }),
    ).resolves.toBeUndefined()
  })

  it('normalizes backend failures for the caller', async () => {
    apiClient.defaults.adapter = async (config) => {
      throw responseFailure(config, 403, 'Download forbidden')
    }

    await expect(
      downloadOriginalFile({ id: 9, name: 'private.txt', size: 12 }),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: 'ApiError',
        kind: 'authorization',
        status: 403,
        message: 'Download forbidden',
      }),
    )
  })
})

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    config,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    data,
  }
}

function responseFailure(
  config: InternalAxiosRequestConfig,
  status: number,
  message: string,
) {
  return new AxiosError('failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers: new AxiosHeaders(),
    data: { statusCode: status, message },
  })
}
