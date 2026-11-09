import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tokenStorage } from '../auth/tokenStorage'
import { fetchFileThumbnail } from './thumbnailApi'
import { FileThumbnail } from './FileThumbnail'
import { queueThumbnail } from './thumbnailQueue'

vi.mock('./thumbnailApi', () => ({
  fetchFileThumbnail: vi.fn(),
}))

const load = vi.mocked(fetchFileThumbnail)
const blob = () => new Blob(['png'], { type: 'image/png' })

beforeEach(() => {
  load.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('FileThumbnail', () => {
  it('loads only when visible and revokes its object URL', async () => {
    let reveal!: () => void
    const revoke = vi.fn()

    class Observer {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() {
        reveal = () => this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      disconnect() {}
    }

    vi.stubGlobal('IntersectionObserver', Observer)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:thumbnail'),
      revokeObjectURL: revoke,
    })

    load.mockResolvedValue(blob())

    const view = render(<FileThumbnail fileId={42} />)

    expect(load).not.toHaveBeenCalled()
    expect(view.container.querySelector('img')).toBeNull()

    act(() => reveal())

    await waitFor(() => {
      expect(view.container.querySelector('img'))
        .toHaveAttribute('src', 'blob:thumbnail')
    })

    expect(load).toHaveBeenCalledWith(
      42,
      expect.any(AbortSignal),
    )

    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:thumbnail')
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
    await expect(Promise.all(running)).resolves.toHaveLength(4)
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
