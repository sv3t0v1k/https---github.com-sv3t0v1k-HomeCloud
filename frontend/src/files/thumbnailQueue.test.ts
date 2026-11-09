import { beforeEach, describe, expect, it, vi } from 'vitest'

import { tokenStorage } from '../auth/tokenStorage'
import { fetchFileThumbnail } from './thumbnailApi'
import {
  promoteThumbnail,
  queueThumbnail,
} from './thumbnailQueue'

vi.mock('./thumbnailApi', () => ({
  fetchFileThumbnail: vi.fn(),
}))

const load = vi.mocked(fetchFileThumbnail)
const blob = () => new Blob(['png'], { type: 'image/png' })

beforeEach(() => {
  load.mockReset()
})

describe('Bounded thumbnail queue', () => {
  it('limits pending jobs to 64 plus four active requests', async () => {
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

    const requests = controllers.map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    expect(load).toHaveBeenCalledTimes(4)

    await expect(
      queueThumbnail(999, new AbortController().signal),
    ).rejects.toThrow('Thumbnail queue is full')

    release()
    await expect(Promise.all(requests)).resolves.toHaveLength(68)
  })

  it('rejects an in-flight response after owner generation changes', async () => {
    let finish!: (value: Blob) => void
    const delayed = new Promise<Blob>((resolve) => {
      finish = resolve
    })

    load.mockImplementationOnce(() => delayed)
      .mockResolvedValue(blob())

    const previous = queueThumbnail(
      7001,
      new AbortController().signal,
    )
    const rejected = expect(previous).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(load).toHaveBeenCalledTimes(1)

    tokenStorage.clear()
    finish(blob())

    await rejected

    const current = queueThumbnail(
      7001,
      new AbortController().signal,
    )
    await expect(current).resolves.toBeInstanceOf(Blob)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('deduplicates a file but keeps subscriber cancellation separate', async () => {
    let release!: (value: Blob) => void
    const gate = new Promise<Blob>((resolve) => {
      release = resolve
    })

    load.mockImplementation(() => gate)

    const first = new AbortController()
    const second = new AbortController()

    const a = queueThumbnail(501, first.signal)
    const rejected = expect(a).rejects.toMatchObject({
      name: 'AbortError',
    })

    const b = queueThumbnail(501, second.signal)

    expect(load).toHaveBeenCalledTimes(1)

    first.abort()
    await rejected

    expect(load.mock.calls[0][1]?.aborted).toBe(false)

    release(blob())
    await expect(b).resolves.toBeInstanceOf(Blob)
  })

  it('runs visible jobs before earlier prefetch jobs', async () => {
    const held: Array<(value: Blob) => void> = []
    let started = 0

    load.mockImplementation(() => {
      started += 1
      if (started <= 4) {
        return new Promise<Blob>((resolve) => {
          held.push(resolve)
        })
      }
      return Promise.resolve(blob())
    })

    const controllers = Array.from(
      { length: 6 },
      () => new AbortController(),
    )

    const requests = controllers.slice(0, 4).map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    const prefetch = queueThumbnail(5, controllers[4].signal, 'prefetch')
    const visible = queueThumbnail(6, controllers[5].signal, 'visible')

    held[0](blob())

    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(6)
    })

    expect(load.mock.calls[4][0]).toBe(6)
    expect(load.mock.calls[5][0]).toBe(5)

    held.slice(1).forEach((resolve) => resolve(blob()))
    await Promise.all([...requests, prefetch, visible])
  })

  it('evicts an old prefetch when a visible request arrives at capacity', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    load.mockImplementation(async () => {
      await gate
      return blob()
    })

    const controllers = Array.from(
      { length: 69 },
      () => new AbortController(),
    )

    const running = controllers.slice(0, 4).map((controller, index) =>
      queueThumbnail(index + 1, controller.signal),
    )

    const background = controllers.slice(4, 68).map((controller, index) =>
      queueThumbnail(index + 5, controller.signal, 'prefetch'),
    )

    const evicted = expect(background[0]).rejects.toMatchObject({
      name: 'ThumbnailQueuePressureError',
    })

    expect(load).toHaveBeenCalledTimes(4)

    const visible = queueThumbnail(
      999,
      controllers[68].signal,
      'visible',
    )

    await evicted
    expect(load).toHaveBeenCalledTimes(4)

    release()

    await expect(
      Promise.all([...running, ...background.slice(1), visible]),
    ).resolves.toHaveLength(68)

    // Priority applies even after the prefetch queue reached capacity.
    expect(load.mock.calls[4][0]).toBe(999)
  })

  it('promotes a prefetch job without duplicating the request', async () => {
    const held: Array<(value: Blob) => void> = []
    let started = 0

    load.mockImplementation(() => {
      started += 1
      if (started <= 4) {
        return new Promise<Blob>((resolve) => {
          held.push(resolve)
        })
      }
      return Promise.resolve(blob())
    })

    const controllers = Array.from(
      { length: 6 },
      () => new AbortController(),
    )

    const active = controllers.slice(0, 4).map((controller, index) =>
      queueThumbnail(index + 101, controller.signal),
    )

    const promoted = queueThumbnail(105, controllers[4].signal, 'prefetch')
    const other = queueThumbnail(106, controllers[5].signal, 'prefetch')

    promoteThumbnail(106)
    held[0](blob())

    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(6)
    })

    expect(load.mock.calls[4][0]).toBe(106)

    held.slice(1).forEach((resolve) => resolve(blob()))
    await Promise.all([...active, promoted, other])
  })
})
