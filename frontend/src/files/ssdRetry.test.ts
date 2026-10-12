// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import type { FileItem } from '../types/files'
import { completeUploadSession, withChunkRetry } from './upload'

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
})
