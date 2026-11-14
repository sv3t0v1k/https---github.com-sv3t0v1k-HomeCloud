import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_RETAINED_THUMBNAILS,
  MAX_RETAINED_THUMBNAIL_BYTES,
  retainThumbnailUrl,
  type ThumbnailUrlLease,
} from './thumbnailUrlBudget'

describe('Thumbnail ObjectURL memory budget', () => {
  const retained: ThumbnailUrlLease[] = []
  const revoke = vi.fn()
  let sequence = 0

  beforeEach(() => {
    sequence = 0
    revoke.mockReset()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:budget-${++sequence}`),
      revokeObjectURL: revoke,
    })
  })

  afterEach(() => {
    retained.splice(0).forEach((lease) => lease.release())
    vi.unstubAllGlobals()
  })

  const hold = (size: number, onEvict = vi.fn()) => {
    const lease = retainThumbnailUrl({ size } as Blob, onEvict)
    retained.push(lease)
    return lease
  }

  it('limits count and retains the most recently used entries', () => {
    const evicted = vi.fn()
    const first = hold(1, evicted)
    const secondEvicted = vi.fn()
    hold(1, secondEvicted)

    for (let i = 2; i < MAX_RETAINED_THUMBNAILS; i++) {
      hold(1)
    }

    first.touch()
    hold(1)

    expect(evicted).not.toHaveBeenCalled()
    expect(secondEvicted).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:budget-2')
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('limits total Blob bytes independently of entry count', () => {
    const size = 2 * 1024 * 1024
    const count = MAX_RETAINED_THUMBNAIL_BYTES / size
    const evicted = vi.fn()

    hold(size, evicted)

    for (let i = 1; i < count; i++) {
      hold(size)
    }

    expect(revoke).not.toHaveBeenCalled()

    hold(size)

    expect(evicted).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:budget-1')
  })

  it('evicts offscreen entries before older visible entries', () => {
    const visible = hold(1)
    visible.setVisible(true)

    const offscreenEvicted = vi.fn()
    hold(1, offscreenEvicted)

    for (let index = 2; index < MAX_RETAINED_THUMBNAILS; index++) {
      hold(1).setVisible(true)
    }

    const next = hold(1)

    expect(offscreenEvicted).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:budget-2')
    expect(revoke).not.toHaveBeenCalledWith(visible.url)
    expect(revoke).not.toHaveBeenCalledWith(next.url)
  })

  it('releases URLs exactly once', () => {
    const lease = hold(1)
    lease.release()
    lease.release()

    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('rejects oversize Blob before allocating an ObjectURL', () => {
    expect(() => hold(MAX_RETAINED_THUMBNAIL_BYTES + 1))
      .toThrow(RangeError)

    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
