import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '../api/client'
import { UPLOAD_CHUNK_SIZE, uploadFile, type UploadProgress } from './upload'

describe('uploadFile', () => {
  beforeEach(() => {
    apiClient.defaults.adapter = undefined
  })

  afterEach(() => {
    apiClient.defaults.adapter = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    [UPLOAD_CHUNK_SIZE - 1, [UPLOAD_CHUNK_SIZE - 1]],
    [UPLOAD_CHUNK_SIZE, [UPLOAD_CHUNK_SIZE]],
    [UPLOAD_CHUNK_SIZE + 1, [UPLOAD_CHUNK_SIZE, 1]],
    [UPLOAD_CHUNK_SIZE + 7, [UPLOAD_CHUNK_SIZE, 7]],
  ])('slices %i bytes into sequential chunks', async (size, expectedSizes) => {
    const file = fakeFile(size, 'данные.bin')
    const indexes: string[] = []
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') {
        expect(config.data).toBe(JSON.stringify({
          filename: 'данные.bin',
          totalSize: size,
          chunkSize: UPLOAD_CHUNK_SIZE,
        }))
        return ok(config, { uploadId: 'upload/a', totalChunks: expectedSizes.length }, 201)
      }
      if (config.url?.endsWith('/chunk')) {
        const form = config.data as FormData
        indexes.push(String(form.get('chunkIndex')))
        return ok(config, {})
      }
      if (config.url?.endsWith('/complete')) return ok(config, uploadedFile(size))
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await uploadFile({ file, retryDelayMs: 0 })

    expect(file.slice).toHaveBeenCalledTimes(expectedSizes.length)
    expect(indexes).toEqual(expectedSizes.map((_, index) => String(index)))
    let offset = 0
    for (const expectedSize of expectedSizes) {
      expect(file.slice).toHaveBeenCalledWith(offset, offset + expectedSize)
      offset += expectedSize
    }
  })

  it('targets the current folder and reaches 100 percent only after completion', async () => {
    const progress: UploadProgress[] = []
    let completeStarted = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') {
        expect(JSON.parse(config.data as string)).toMatchObject({ parentId: 42 })
        return ok(config, { uploadId: 'u1', totalChunks: 1 }, 201)
      }
      if (config.url?.endsWith('/chunk')) {
        config.onUploadProgress?.({ loaded: 4 } as never)
        config.onUploadProgress?.({ loaded: 10 } as never)
        return ok(config, {})
      }
      if (config.url?.endsWith('/complete')) {
        completeStarted = true
        expect(progress[progress.length - 1]).toMatchObject({ stage: 'completing', percent: 99 })
        return ok(config, uploadedFile(10))
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await uploadFile({
      file: fakeFile(10),
      parentId: 42,
      retryDelayMs: 0,
      onProgress: (value) => progress.push(value),
    })

    expect(completeStarted).toBe(true)
    expect(progress).toContainEqual(expect.objectContaining({ bytesSent: 4, percent: 40 }))
    expect(progress[progress.length - 1]).toMatchObject({
      stage: 'success',
      bytesSent: 10,
      percent: 100,
    })
  })

  it('retries transient chunk failures up to three total attempts, then completes', async () => {
    let chunkAttempts = 0
    let completed = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') return ok(config, { uploadId: 'u1', totalChunks: 1 }, 201)
      if (config.url?.endsWith('/chunk')) {
        chunkAttempts += 1
        if (chunkAttempts < 3) throw failure(config, 503)
        return ok(config, {})
      }
      if (config.url?.endsWith('/complete')) {
        completed = true
        return ok(config, uploadedFile(3))
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await uploadFile({ file: fakeFile(3), retryDelayMs: 0 })

    expect(chunkAttempts).toBe(3)
    expect(completed).toBe(true)
  })

  it('does not retry a permanent 4xx chunk failure or call complete', async () => {
    let chunkAttempts = 0
    let completeCalls = 0
    let deleteCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') return ok(config, { uploadId: 'u1', totalChunks: 1 }, 201)
      if (config.url?.endsWith('/chunk')) {
        chunkAttempts += 1
        throw failure(config, 400)
      }
      if (config.method === 'delete') {
        deleteCalls += 1
        return ok(config, undefined)
      }
      if (config.url?.endsWith('/complete')) completeCalls += 1
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await expect(uploadFile({ file: fakeFile(3), retryDelayMs: 0 })).rejects.toMatchObject({
      kind: 'validation',
    })
    expect(chunkAttempts).toBe(1)
    expect(completeCalls).toBe(0)
    expect(deleteCalls).toBe(1)
  })

  it('releases the server session after exhausted transient failures', async () => {
    let chunkAttempts = 0
    let deleteCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') return ok(config, { uploadId: 'u1', totalChunks: 1 }, 201)
      if (config.url?.endsWith('/chunk')) {
        chunkAttempts += 1
        throw failure(config, 503)
      }
      if (config.method === 'delete') {
        deleteCalls += 1
        return ok(config, undefined)
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await expect(uploadFile({ file: fakeFile(3), retryDelayMs: 0 })).rejects.toMatchObject({
      kind: 'server',
    })
    expect(chunkAttempts).toBe(3)
    expect(deleteCalls).toBe(1)
  })

  it('aborts the active request, schedules no later chunk, and best-effort deletes the session', async () => {
    const controller = new AbortController()
    const chunkIndexes: string[] = []
    let deleteCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') return ok(config, { uploadId: 'u1', totalChunks: 2 }, 201)
      if (config.method === 'delete') {
        deleteCalls += 1
        return ok(config, undefined)
      }
      if (config.url?.endsWith('/chunk')) {
        chunkIndexes.push(String((config.data as FormData).get('chunkIndex')))
        controller.abort()
        throw new CanceledError('cancelled', config)
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    await expect(
      uploadFile({
        file: fakeFile(UPLOAD_CHUNK_SIZE + 1),
        signal: controller.signal,
        retryDelayMs: 0,
      }),
    ).rejects.toBeTruthy()

    expect(chunkIndexes).toEqual(['0'])
    expect(deleteCalls).toBe(1)
  })

  it('keeps exact 50 GiB metadata and sends all 5120 synthetic chunks without giant allocations', async () => {
    const size = 53687091200
    let chunks = 0
    const file = fakeFile(size)
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: size, maxChunkBytes: UPLOAD_CHUNK_SIZE, maxChunks: 100000 })
      if (config.url === '/uploads/session') {
        expect(JSON.parse(config.data as string)).toMatchObject({ totalSize: size, chunkSize: UPLOAD_CHUNK_SIZE })
        return ok(config, { uploadId: 'large', totalChunks: 5120 }, 201)
      }
      if (config.url?.endsWith('/chunk')) { chunks++; return ok(config, {}) }
      if (config.url?.endsWith('/complete')) return ok(config, uploadedFile(size))
      throw new Error(`Unexpected request: ${config.url}`)
    }
    const result = await uploadFile({ file })
    expect(result.size).toBe(size)
    expect(chunks).toBe(5120)
    expect(file.slice).toHaveBeenCalledTimes(5120)
    expect(file.slice).toHaveBeenLastCalledWith(size - UPLOAD_CHUNK_SIZE, size)
  })

  it.each(['2', 'Wed, 01 Jan 2025 00:00:02 GMT'])('waits for Retry-After %s then retries the same chunk', async (retryAfter) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    const indexes: string[] = []
    const progress: UploadProgress[] = []
    apiClient.defaults.adapter = uploadAdapter((config) => {
      indexes.push(String((config.data as FormData).get('chunkIndex')))
      config.onUploadProgress?.({ loaded: indexes.length === 1 ? 2 : 1 } as never)
      if (indexes.length === 1) throw failure(config, 429, retryAfter)
      return ok(config, {})
    }, undefined, undefined, 5)
    const uploading = uploadFile({ file: fakeFile(13), onProgress: (value) => progress.push(value) })
    await vi.advanceTimersByTimeAsync(0)
    expect(indexes).toEqual(['0'])
    await vi.advanceTimersByTimeAsync(1999)
    expect(indexes).toEqual(['0'])
    await vi.advanceTimersByTimeAsync(1)
    await uploading
    expect(indexes).toEqual(['0', '0', '1', '2'])
    expect(progress.map((value) => value.bytesSent)).toEqual([...progress.map((value) => value.bytesSent)].sort((a, b) => a - b))
    expect(progress[progress.length - 1]).toMatchObject({ stage: 'success', percent: 100 })
  })

  it('stops repeated 429 after three attempts, aborts safely and never skips a chunk', async () => {
    vi.useFakeTimers()
    const indexes: string[] = []
    let deletes = 0
    let completes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => {
      indexes.push(String((config.data as FormData).get('chunkIndex')))
      throw failure(config, 429, '1')
    }, (config) => { deletes++; return ok(config, {}) }, () => { completes++ })
    const result = expect(uploadFile({ file: fakeFile(UPLOAD_CHUNK_SIZE + 1) })).rejects.toMatchObject({
      kind: 'rate-limit', message: 'Сервер ограничил частоту загрузки. Подождите и повторите загрузку.',
    })
    await vi.runAllTimersAsync()
    await result
    expect(indexes).toEqual(['0', '0', '0'])
    expect(deletes).toBe(1)
    expect(completes).toBe(0)
  })

  it.each([undefined, 'bad-header', '-1', '1.5', '0', 'Tue, 31 Dec 2024 23:59:00 GMT'])('uses bounded fallback for invalid, absent or elapsed Retry-After %s', async (retryAfter) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    let attempts = 0
    apiClient.defaults.adapter = uploadAdapter((config) => {
      attempts++
      if (attempts < 3) throw failure(config, 429, retryAfter)
      return ok(config, {})
    })
    const uploading = uploadFile({ file: fakeFile(1), retryDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(249)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await uploading
    expect(attempts).toBe(3)
  })

  it.each(['61', '999999999999999999999999999999999999', 'Thu, 01 Jan 2099 00:00:00 GMT'])('fails instead of retrying early for excessive Retry-After %s', async (retryAfter) => {
    vi.useFakeTimers()
    let attempts = 0
    let deletes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => { attempts++; throw failure(config, 429, retryAfter) },
      (config) => { deletes++; return ok(config, {}) })
    await expect(uploadFile({ file: fakeFile(1) })).rejects.toMatchObject({ kind: 'rate-limit' })
    expect(attempts).toBe(1)
    expect(deletes).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cumulative retry waits across chunks to five minutes', async () => {
    vi.useFakeTimers()
    let attempts = 0
    let deletes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => {
      attempts++
      if (attempts % 2 === 1) throw failure(config, 429, '60')
      return ok(config, {})
    }, (config) => { deletes++; return ok(config, {}) }, undefined, 1)
    const start = Date.now()
    const result = expect(uploadFile({ file: fakeFile(6) })).rejects.toMatchObject({ kind: 'rate-limit' })
    await vi.runAllTimersAsync()
    await result
    expect(Date.now() - start).toBe(300_000)
    expect(attempts).toBe(11)
    expect(deletes).toBe(1)
  })

  it('retries rate-limited abort cleanup while preserving the original failure', async () => {
    vi.useFakeTimers()
    let deletes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => { throw failure(config, 400) },
      (config) => {
        deletes++
        expect(config.timeout).toBeLessThanOrEqual(10_000)
        if (deletes === 1) throw failure(config, 429, '1')
        return ok(config, {})
      })
    const result = expect(uploadFile({ file: fakeFile(1) })).rejects.toMatchObject({ kind: 'validation' })
    await vi.advanceTimersByTimeAsync(999)
    expect(deletes).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(deletes).toBe(2)
  })

  it.each(['1', '11'])('bounds unsuccessful abort cleanup with Retry-After %s', async (retryAfter) => {
    vi.useFakeTimers()
    let deletes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => { throw failure(config, 400) },
      (config) => { deletes++; throw failure(config, 429, retryAfter) })
    const start = Date.now()
    const result = expect(uploadFile({ file: fakeFile(1) })).rejects.toMatchObject({ kind: 'validation' })
    await vi.runAllTimersAsync()
    await result
    expect(deletes).toBe(retryAfter === '1' ? 3 : 1)
    expect(Date.now() - start).toBeLessThanOrEqual(10_000)
  })

  it('returns the original failure within the cleanup budget even when DELETE never settles', async () => {
    vi.useFakeTimers()
    let cleanupSignal: AbortSignal | undefined
    apiClient.defaults.adapter = uploadAdapter((config) => { throw failure(config, 400) },
      (config) => {
        cleanupSignal = config.signal as AbortSignal
        return new Promise<AxiosResponse>(() => {})
      })
    const result = expect(uploadFile({ file: fakeFile(1) })).rejects.toMatchObject({ kind: 'validation' })
    await vi.advanceTimersByTimeAsync(9999)
    expect(cleanupSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(cleanupSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('interrupts a rate-limit wait on cancellation, deletes the session and sends no next chunk', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    let deletes = 0
    apiClient.defaults.adapter = uploadAdapter((config) => { attempts++; throw failure(config, 429, '60') },
      (config) => { deletes++; return ok(config, {}) })
    const result = expect(uploadFile({ file: fakeFile(UPLOAD_CHUNK_SIZE + 1), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    controller.abort()
    await result
    expect(attempts).toBe(1)
    expect(deletes).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('negotiates a larger bounded chunk when the explicit count limit requires it', async () => {
    const size = 3 * UPLOAD_CHUNK_SIZE
    const selectedChunk = Math.ceil(size / 2)
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: size, maxChunkBytes: 2 * UPLOAD_CHUNK_SIZE, maxChunks: 2 })
      if (config.url === '/uploads/session') {
        expect(JSON.parse(config.data as string).chunkSize).toBe(selectedChunk)
        return ok(config, { uploadId: 'adaptive', totalChunks: 2 }, 201)
      }
      if (config.url?.endsWith('/chunk')) return ok(config, {})
      if (config.url?.endsWith('/complete')) return ok(config, uploadedFile(size))
      throw new Error(`Unexpected request: ${config.url}`)
    }
    const file = fakeFile(size)
    await uploadFile({ file })
    expect(file.slice).toHaveBeenCalledTimes(2)
  })

  it.each([9, 10])('accepts inclusive effective server limit %i', async (size) => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: 10, maxChunkBytes: 10, maxChunks: 10 })
      if (config.url === '/uploads/session') return ok(config, { uploadId: 'limit', totalChunks: 1 }, 201)
      if (config.url?.endsWith('/chunk')) return ok(config, {})
      if (config.url?.endsWith('/complete')) return ok(config, uploadedFile(size))
      throw new Error(`Unexpected request: ${config.url}`)
    }
    expect((await uploadFile({ file: fakeFile(size) })).size).toBe(size)
  })

  it('rejects effective limit + 1 before allocating chunks or reserving a session', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ok(config, { effectiveMaxFileBytes: 10, maxChunkBytes: 10, maxChunks: 10 }))
    apiClient.defaults.adapter = adapter
    const file = fakeFile(11)
    await expect(uploadFile({ file })).rejects.toThrow('ограничение')
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(file.slice).not.toHaveBeenCalled()
  })

  it('rejects empty and unsafe files before creating a session', async () => {
    const adapter = vi.fn()
    apiClient.defaults.adapter = adapter

    await expect(uploadFile({ file: fakeFile(0) })).rejects.toThrow('positive safe integer')
    await expect(uploadFile({ file: fakeFile(Number.MAX_SAFE_INTEGER + 1) })).rejects.toThrow(
      'positive safe integer',
    )
    expect(adapter).not.toHaveBeenCalled()
  })
})

function fakeFile(size: number, name = 'sample.bin'): File & { slice: ReturnType<typeof vi.fn> } {
  const slice = vi.fn((start: number, end: number) => sizedBlob(Math.max(0, end - start)))
  return {
    name,
    size,
    type: 'application/octet-stream',
    slice,
  } as unknown as File & { slice: ReturnType<typeof vi.fn> }
}

function sizedBlob(size: number) {
  const blob = new Blob()
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

function uploadedFile(size: number) {
  return {
    id: 7,
    name: 'sample.bin',
    size,
    mimeType: 'application/octet-stream',
    isDeleted: false,
    isStarred: false,
    parentId: null,
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function ok(
  config: InternalAxiosRequestConfig,
  data: unknown,
  status = 200,
): AxiosResponse {
  return {
    config,
    status,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    data: { success: true, data },
  }
}

function failure(config: InternalAxiosRequestConfig, status: number, retryAfter?: string) {
  const headers = new AxiosHeaders()
  if (retryAfter !== undefined) headers.set('Retry-After', retryAfter)
  return new AxiosError('failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers,
    data: { statusCode: status, message: 'Upload failed' },
  })
}

function uploadAdapter(
  chunk: (config: InternalAxiosRequestConfig) => AxiosResponse,
  abort: (config: InternalAxiosRequestConfig) => AxiosResponse | Promise<AxiosResponse> = (config) => ok(config, {}),
  complete?: () => void,
  maxChunkBytes = UPLOAD_CHUNK_SIZE,
) {
  return async (config: InternalAxiosRequestConfig) => {
    if (config.url === '/uploads/limits') return ok(config, { effectiveMaxFileBytes: Number.MAX_SAFE_INTEGER, maxChunkBytes, maxChunks: 100_000 })
    if (config.url === '/uploads/session') return ok(config, { uploadId: 'retry-session', totalChunks: 1 }, 201)
    if (config.method === 'delete') return abort(config)
    if (config.url?.endsWith('/chunk')) return chunk(config)
    if (config.url?.endsWith('/complete')) { complete?.(); return ok(config, uploadedFile(3)) }
    throw new Error(`Unexpected request: ${config.url}`)
  }
}
