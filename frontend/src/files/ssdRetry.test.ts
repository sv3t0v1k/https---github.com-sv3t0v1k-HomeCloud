// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import type { FileItem } from '../types/files'
import { completeUploadSession, withChunkRetry } from './upload'
import { UploadQueue } from './uploadQueue'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
const request = vi.mocked(apiRequest)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
  request.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SSD finalization retry invariants', () => {
  it('retains the complete Retry-After when receipt reconciliation also fails', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const original = new ApiError('SSD finalization is busy', 'busy', 503, '1')
    const stored = { id: 10, name: 'stored.bin', size: 123 } as FileItem
    let completeAttempts = 0
    request.mockImplementation(async (config) => {
      if (config.method === 'GET') throw new ApiError('Connection lost', 'network')
      if (++completeAttempts === 1) throw original
      return stored
    })
    const pending = withChunkRetry(() => completeUploadSession('receipt'), undefined, 250, { remainingWaitMs: 5000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(completeAttempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(stored)
    expect(completeAttempts).toBe(2)
  })

  it('adds bounded positive jitter and consumes a shared wait budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.8)
    const times: number[] = []
    const send = vi.fn(async () => {
      times.push(Date.now())
      if (times.length < 3) throw new ApiError('SSD finalization is busy', 'busy', 503)
      return 'committed'
    })
    const budget = { remainingWaitMs: 2500 }
    const pending = withChunkRetry(send, undefined, 250, budget)
    await vi.advanceTimersByTimeAsync(299)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(599)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('committed')
    expect(times).toEqual([0, 300, 900])
    expect(budget.remainingWaitMs).toBe(1600)
  })

  it('stops instead of clamping an excessive server wait to an earlier replay', async () => {
    const original = new ApiError('SSD finalization is busy', 'busy', 503, '61')
    const send = vi.fn(async () => { throw original })
    const budget = { remainingWaitMs: 300000, notBefore: undefined as number | undefined }
    await expect(withChunkRetry(send, undefined, 250, budget)).rejects.toBe(original)
    expect(send).toHaveBeenCalledTimes(1)
    expect(budget.notBefore).toBe(61000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule a retry exceeding the remaining cumulative wait budget', async () => {
    const original = new ApiError('SSD finalization is busy', 'busy', 503, '1')
    const send = vi.fn(async () => { throw original })
    const budget = { remainingWaitMs: 750 }
    await expect(withChunkRetry(send, undefined, 250, budget)).rejects.toBe(original)
    expect(send).toHaveBeenCalledTimes(1)
    expect(budget.remainingWaitMs).toBe(750)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cancellation receipt replay to five seconds when the complete request stalls', async () => {
    const stored = { id: 10, name: 'stored.bin', size: 123 } as FileItem
    const saved = JSON.stringify([{ id: 'restored', name: 'stored.bin', size: 123,
      uploadId: 'committed', committedBytes: 123 }])
    const metadata = { uploadId: 'committed', filename: 'stored.bin', totalSize: 123,
      chunkSize: 123, totalChunks: 1, uploadedSize: 123, status: 'completed',
      expiresAt: new Date(60000).toISOString(), chunks: [], file: stored }
    const storage = { getItem: () => saved, setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage
    let stalledSignal: { readonly aborted: boolean } | undefined
    let replayTimeout: number | undefined
    request.mockImplementation(async (config) => {
      if (config.signal?.aborted) throw new ApiError('Request cancelled', 'network')
      if (config.method === 'DELETE') throw new ApiError('Cannot abort a completed upload', 'validation', 400)
      if (config.method === 'GET') return metadata
      if (config.method === 'POST' && config.url?.endsWith('/complete')) {
        stalledSignal = config.signal
        replayTimeout = config.timeout
        return await new Promise<never>((_resolve, reject) => {
          config.signal?.addEventListener?.('abort', () => reject(new ApiError('Request cancelled', 'network')), { once: true })
        })
      }
      throw new Error('Unexpected request')
    })
    const queue = new UploadQueue(42, storage)
    try {
      queue.cancel('restored')
      await vi.advanceTimersByTimeAsync(0)
      expect(queue.getSnapshot()[0]).toMatchObject({ state: 'completing', completedFile: stored })
      expect(replayTimeout).toBe(5000)
      await vi.advanceTimersByTimeAsync(4999)
      expect(queue.getSnapshot()[0].state).toBe('completing')
      expect(stalledSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(stalledSignal?.aborted).toBe(true)
      expect(queue.getSnapshot()[0]).toMatchObject({ state: 'error', completedFile: stored })
      expect(queue.getSnapshot()[0].error).toContain('Не удалось подтвердить отмену')
      expect(request.mock.calls.filter(([config]) => config.method === 'POST')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { queue.dispose() }
  })
})
