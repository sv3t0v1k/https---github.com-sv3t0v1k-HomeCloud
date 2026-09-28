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
    vi.restoreAllMocks()
  })

  it.each([
    [UPLOAD_CHUNK_SIZE - 1, [UPLOAD_CHUNK_SIZE - 1]],
    [UPLOAD_CHUNK_SIZE, [UPLOAD_CHUNK_SIZE]],
    [UPLOAD_CHUNK_SIZE + 7, [UPLOAD_CHUNK_SIZE, 7]],
  ])('slices %i bytes into sequential chunks', async (size, expectedSizes) => {
    const file = fakeFile(size, 'данные.bin')
    const indexes: string[] = []
    apiClient.defaults.adapter = async (config) => {
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

function failure(config: InternalAxiosRequestConfig, status: number) {
  return new AxiosError('failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers: new AxiosHeaders(),
    data: { statusCode: status, message: 'Upload failed' },
  })
}
