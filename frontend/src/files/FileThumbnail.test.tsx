import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tokenStorage } from '../auth/tokenStorage'
import { fetchFileThumbnail } from './thumbnailApi'
import { FileThumbnail } from './FileThumbnail'
import { queueThumbnail } from './thumbnailQueue'
import {
  MAX_RETAINED_THUMBNAILS,
  retainThumbnailUrl,
} from './thumbnailUrlBudget'

vi.mock('./thumbnailApi', () => ({
  fetchFileThumbnail: vi.fn(),
}))

const load = vi.mocked(fetchFileThumbnail)
const blob = () => new Blob(['png'], { type: 'image/png' })

function mockObservers() {
  const observers: Observer[] = []

  class Observer {
    constructor(
      private readonly callback: IntersectionObserverCallback,
      readonly options?: IntersectionObserverInit,
    ) {
      observers.push(this)
    }

    observe() {}
    disconnect() {}

    emit(isIntersecting: boolean) {
      this.callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }
  }

  vi.stubGlobal('IntersectionObserver', Observer)

  const get = (margin: string) => {
    const observer = observers.find(
      (candidate) => candidate.options?.rootMargin === margin,
    )
    if (!observer) throw new Error(`Observer ${margin} missing`)
    return observer
  }

  return {
    prefetch: () => get('160px'),
    viewport: () => get('0px'),
  }
}


beforeEach(() => {
  load.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('FileThumbnail', () => {
  it('prefetches near the viewport and revokes its URL on unmount', async () => {
    const observers = mockObservers()
    const revoke = vi.fn()

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:thumbnail'),
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={42} />)

    expect(load).not.toHaveBeenCalled()
    expect(view.container.querySelector('img')).toBeNull()

    act(() => observers.prefetch().emit(true))

    await waitFor(() => {
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:thumbnail')
    })

    expect(load).toHaveBeenCalledWith(
      42,
      expect.any(AbortSignal),
    )

    // Entering the actual viewport must not download the same file twice.
    act(() => observers.viewport().emit(true))
    expect(load).toHaveBeenCalledOnce()

    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:thumbnail')
  })

  it('cancels unfinished work after scrolling away and retries on return', async () => {
    const observers = mockObservers()

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:restored'),
      revokeObjectURL: vi.fn(),
    })

    let finishFirst!: (value: Blob) => void
    const firstLoad = new Promise<Blob>((resolve) => {
      finishFirst = resolve
    })

    load.mockImplementationOnce(() => firstLoad)
      .mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={88} />)

    act(() => observers.prefetch().emit(true))
    await waitFor(() => expect(load).toHaveBeenCalledOnce())

    const firstSignal = load.mock.calls[0][1]
    expect(firstSignal?.aborted).toBe(false)

    // Both zones become invisible, cancelling outstanding work.
    act(() => {
      observers.viewport().emit(false)
      observers.prefetch().emit(false)
    })

    expect(firstSignal?.aborted).toBe(true)

    await act(async () => {
      finishFirst(blob())
      await Promise.resolve()
    })

    expect(view.container.querySelector('img')).toBeNull()

    act(() => observers.prefetch().emit(true))

    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2)
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:restored')
    })

    view.unmount()
  })

  it('keeps an already loaded thumbnail during normal scrolling', async () => {
    const observers = mockObservers()
    const revoke = vi.fn()

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:kept'),
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={90} />)

    act(() => observers.prefetch().emit(true))

    await waitFor(() => {
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:kept')
    })

    act(() => observers.prefetch().emit(false))

    expect(view.container.querySelector('img'))
      .toHaveAttribute('src', 'blob:kept')
    expect(revoke).not.toHaveBeenCalled()

    act(() => observers.prefetch().emit(true))

    expect(load).toHaveBeenCalledOnce()

    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:kept')
  })

  it('reloads an offscreen eviction when entering the viewport', async () => {
    const observers = mockObservers()
    const revoke = vi.fn()
    let created = 0

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:eviction-${++created}`),
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={7001} />)
    const extra: Array<{ release(): void }> = []

    try {
      act(() => observers.prefetch().emit(true))

      await waitFor(() => {
        expect(view.container.querySelector('img'))
          .toHaveAttribute('src', 'blob:eviction-1')
      })

      act(() => {
        for (let index = 0; index < MAX_RETAINED_THUMBNAILS; index++) {
          extra.push(retainThumbnailUrl(blob(), () => {}))
        }
      })

      await waitFor(() => {
        expect(view.container.querySelector('img')).toBeNull()
      })

      expect(revoke).toHaveBeenCalledWith('blob:eviction-1')

      // Prefetch stays true: viewport entry must independently
      // trigger reloading without toggling shouldLoad.
      act(() => observers.viewport().emit(true))

      await waitFor(() => {
        expect(load).toHaveBeenCalledTimes(2)
        expect(view.container.querySelector('img')).not.toBeNull()
      })
    } finally {
      view.unmount()
      extra.forEach((lease) => lease.release())
    }
  })

  it('retries visible eviction once, without an eviction storm', async () => {
    const observers = mockObservers()
    const revoke = vi.fn()
    let created = 0

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:visible-${++created}`),
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={7002} />)
    const extra: Array<{ release(): void }> = []

    try {
      act(() => observers.viewport().emit(true))

      await waitFor(() => {
        expect(view.container.querySelector('img'))
          .toHaveAttribute('src', 'blob:visible-1')
      })

      // All entries are considered visible, forcing eviction of
      // the oldest visible thumbnail.
      act(() => {
        for (let i = 0; i < MAX_RETAINED_THUMBNAILS; i++) {
          extra.push(retainThumbnailUrl(blob(), () => {}, true))
        }
      })

      await waitFor(() => {
        expect(load).toHaveBeenCalledTimes(2)
        expect(view.container.querySelector('img'))
          .toHaveAttribute('src', 'blob:visible-98')
      })

      expect(revoke).toHaveBeenCalledWith('blob:visible-1')

      // Evict the reloaded entry while it remains visible.
      // A second automatic retry would cause an unbounded loop.
      act(() => {
        for (let i = 0; i < MAX_RETAINED_THUMBNAILS; i++) {
          extra.push(retainThumbnailUrl(blob(), () => {}, true))
        }
      })

      await waitFor(() => {
        expect(view.container.querySelector('img')).toBeNull()
      })

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(load).toHaveBeenCalledTimes(2)

      // A new visibility period allows another bounded attempt.
      act(() => observers.viewport().emit(false))
      act(() => observers.viewport().emit(true))

      await waitFor(() => {
        expect(load).toHaveBeenCalledTimes(3)
        expect(view.container.querySelector('img')).not.toBeNull()
      })
    } finally {
      view.unmount()
      extra.forEach((lease) => lease.release())
    }
  })

  it('keeps the fallback icon if loading fails', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    load.mockRejectedValue(new Error('Image unavailable'))

    const view = render(<FileThumbnail fileId={7} />)

    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('.file-icon-image'))
      .toHaveAttribute('data-thumbnail-status', 'placeholder')
  })

  it('rejects queued requests after an owner change', async () => {
    const finish: Array<(value: Blob) => void> = []

    load.mockImplementation(() => new Promise((resolve) => {
      finish.push(resolve)
    }))

    const controllers = Array.from(
      { length: 5 },
      () => new AbortController(),
    )

    const running = controllers.slice(0, 4).map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    // Attach rejection assertions before changing the owner.
    const runningAssertions = running.map(async (request) => {
      await expect(request).rejects.toMatchObject({
        name: 'AbortError',
      })
    })

    const queued = queueThumbnail(99, controllers[4].signal)
    const rejected = expect(queued).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(load).toHaveBeenCalledTimes(4)

    tokenStorage.clear()
    finish[0](blob())

    await rejected
    expect(load).toHaveBeenCalledTimes(4)

    finish.slice(1).forEach((resolve) => resolve(blob()))
    await Promise.all(runningAssertions)
  })

  it('retries a visible thumbnail when a full queue has capacity', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:retried'),
      revokeObjectURL: vi.fn(),
    })

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    load.mockImplementation(async () => {
      await gate
      return blob()
    })

    const controllers = Array.from(
      { length: 68 },
      () => new AbortController(),
    )

    const running = controllers.map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    let view: ReturnType<typeof render> | undefined

    try {
      view = render(<FileThumbnail fileId={999} />)

      await act(async () => {
        await Promise.resolve()
      })

      expect(load).toHaveBeenCalledTimes(4)

      release()

      await waitFor(() => {
        expect(load.mock.calls.some(([id]) => id === 999)).toBe(true)
        expect(view?.container.querySelector('img'))
          .toHaveAttribute('src', 'blob:retried')
      })

      await expect(Promise.all(running)).resolves.toHaveLength(68)
    } finally {
      release()
      view?.unmount()
      await Promise.allSettled(running)
    }
  })

  it('does not retry a full-queue thumbnail after unmount', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    load.mockImplementation(async () => {
      await gate
      return blob()
    })

    const controllers = Array.from(
      { length: 68 },
      () => new AbortController(),
    )

    const running = controllers.map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    const view = render(<FileThumbnail fileId={1000} />)

    try {
      await act(async () => {
        await Promise.resolve()
      })

      view.unmount()
      release()
      await Promise.all(running)

      expect(load.mock.calls.some(([id]) => id === 1000)).toBe(false)
    } finally {
      view.unmount()
      release()
      await Promise.allSettled(running)
    }
  })

  it('does not display a result from a previous signed-in owner', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    const create = vi.fn(() => 'blob:previous-owner')
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: create,
      revokeObjectURL: vi.fn(),
    })

    let finish!: (value: Blob) => void
    load.mockImplementationOnce(() =>
      new Promise<Blob>((resolve) => {
        finish = resolve
      }),
    )

    const view = render(<FileThumbnail fileId={701} />)

    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())

      tokenStorage.clear()

      await act(async () => {
        finish(blob())
        await Promise.resolve()
      })

      expect(create).not.toHaveBeenCalled()
      expect(view.container.querySelector('img')).toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('aborts an old folder thumbnail when navigating to another file', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    const create = vi.fn(() => 'blob:current-folder')
    const revoke = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: create,
      revokeObjectURL: revoke,
    })

    let finishOld!: (value: Blob) => void
    load.mockImplementation((id) => {
      if (id === 801) {
        return new Promise<Blob>((resolve) => {
          finishOld = resolve
        })
      }
      return Promise.resolve(blob())
    })

    const oldView = render(<FileThumbnail fileId={801} />)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())

    const previousSignal = load.mock.calls[0][1]

    oldView.unmount()
    expect(previousSignal?.aborted).toBe(true)

    const newView = render(<FileThumbnail fileId={802} />)

    try {
      await waitFor(() => {
        expect(newView.container.querySelector('img'))
          .toHaveAttribute('src', 'blob:current-folder')
      })

      await act(async () => {
        finishOld(blob())
        await Promise.resolve()
      })

      expect(create).toHaveBeenCalledTimes(1)
      expect(load.mock.calls.map(([id]) => id)).toEqual([801, 802])
    } finally {
      newView.unmount()
    }

    expect(revoke).toHaveBeenCalledWith('blob:current-folder')
  })

  it('revokes stale thumbnails when file version changes', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    const revoke = vi.fn()
    const create = vi.fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: create,
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail key="v1" fileId={42} />)

    await waitFor(() => {
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:first')
    })

    view.rerender(<FileThumbnail key="v2" fileId={42} />)

    await waitFor(() => {
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:second')
    })

    expect(revoke).toHaveBeenCalledWith('blob:first')

    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:second')
  })

  it('limits simultaneous requests to four', async () => {
    const finish: Array<(value: Blob) => void> = []

    load.mockImplementation(() => new Promise((resolve) => {
      finish.push(resolve)
    }))

    const controllers = Array.from(
      { length: 6 },
      () => new AbortController(),
    )

    const requests = controllers.map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    expect(load).toHaveBeenCalledTimes(4)

    finish[0](blob())
    await waitFor(() => expect(load).toHaveBeenCalledTimes(5))

    finish[1](blob())
    await waitFor(() => expect(load).toHaveBeenCalledTimes(6))

    finish.slice(2).forEach((resolve) => resolve(blob()))
    await expect(Promise.all(requests)).resolves.toHaveLength(6)
  })
})
