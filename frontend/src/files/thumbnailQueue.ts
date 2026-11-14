import { tokenStorage } from '../auth/tokenStorage'
import { fetchFileThumbnail } from './thumbnailApi'

const MAX_CONCURRENT = 4
const MAX_PENDING = 64

export class ThumbnailQueuePressureError extends Error {
  constructor(message = 'Thumbnail queue is full') {
    super(message)
    this.name = 'ThumbnailQueuePressureError'
  }
}

export type ThumbnailPriority = 'visible' | 'prefetch'

type Subscriber = {
  signal: AbortSignal
  resolve(value: Blob): void
  reject(reason: unknown): void
  onAbort(): void
}

type Job = {
  key: string
  fileId: number
  ownerGeneration: number
  priority: ThumbnailPriority
  state: 'queued' | 'running' | 'finished'
  controller: AbortController
  subscribers: Set<Subscriber>
}

const pending: Job[] = []
const jobs = new Map<string, Job>()
let active = 0
const capacityListeners = new Set<() => void>()
let notificationScheduled = false

function notifyCapacity() {
  if (notificationScheduled) return
  notificationScheduled = true

  queueMicrotask(() => {
    notificationScheduled = false
    if (pending.length >= MAX_PENDING) return
    for (const listener of [...capacityListeners]) listener()
  })
}

export function onThumbnailQueueCapacity(listener: () => void) {
  capacityListeners.add(listener)
  notifyCapacity()

  return () => {
    capacityListeners.delete(listener)
  }
}

function abortError() {
  return new DOMException('Thumbnail cancelled', 'AbortError')
}

function removePending(job: Job) {
  const index = pending.indexOf(job)
  if (index >= 0) {
    pending.splice(index, 1)
    notifyCapacity()
  }
}

function forget(job: Job) {
  if (jobs.get(job.key) === job) jobs.delete(job.key)
}

function finish(
  job: Job,
  result: { blob: Blob } | { error: unknown },
) {
  if (job.state === 'finished') return

  // Recheck ownership at delivery, including requests already in flight.
  const delivery = job.ownerGeneration === tokenStorage.getOwnerGeneration()
    ? result
    : { error: abortError() }

  job.state = 'finished'
  forget(job)

  const subscribers = [...job.subscribers]
  job.subscribers.clear()

  for (const subscriber of subscribers) {
    subscriber.signal.removeEventListener('abort', subscriber.onAbort)

    if ('error' in delivery) subscriber.reject(delivery.error)
    else subscriber.resolve(delivery.blob)
  }
}

function pump() {
  while (active < MAX_CONCURRENT && pending.length > 0) {
    const visible = pending.findIndex(
      (job) => job.priority === 'visible',
    )
    const [job] = pending.splice(visible >= 0 ? visible : 0, 1)

    if (job.state !== 'queued') continue

    if (
      job.subscribers.size === 0 ||
      job.ownerGeneration !== tokenStorage.getOwnerGeneration()
    ) {
      finish(job, { error: abortError() })
      continue
    }

    job.state = 'running'
    active += 1

    // A cancelled network request retains capacity until it settles.
    void fetchFileThumbnail(job.fileId, job.controller.signal)
      .then(
        (blob) => finish(job, { blob }),
        (error: unknown) => finish(job, { error }),
      )
      .finally(() => {
        active -= 1
        pump()
      })
  }
  notifyCapacity()
}

/** Promote a queued thumbnail when it enters the actual viewport. */
export function promoteThumbnail(fileId: number) {
  const key = `${tokenStorage.getOwnerGeneration()}:${fileId}`
  const job = jobs.get(key)
  if (job?.state === 'queued') job.priority = 'visible'
}

export function queueThumbnail(
  fileId: number,
  signal: AbortSignal,
  priority: ThumbnailPriority = 'visible',
): Promise<Blob> {
  if (signal.aborted) return Promise.reject(abortError())

  const generation = tokenStorage.getOwnerGeneration()
  const key = `${generation}:${fileId}`

  // Old sessions must not occupy the bounded pending queue.
  for (const queued of [...pending]) {
    if (queued.ownerGeneration !== generation) {
      removePending(queued)
      finish(queued, { error: abortError() })
    }
  }

  let job = jobs.get(key)

  if (!job) {
    if (pending.length >= MAX_PENDING) {
      // A currently visible file may replace the oldest prefetch.
      // Never evict active work or another visible request.
      const victim = priority === 'visible'
        ? pending.find((item) => item.priority === 'prefetch')
        : undefined

      if (!victim) {
        return Promise.reject(new ThumbnailQueuePressureError())
      }

      removePending(victim)
      finish(victim, {
        error: new ThumbnailQueuePressureError('Thumbnail prefetch displaced'),
      })
    }

    job = {
      key,
      fileId,
      ownerGeneration: generation,
      priority,
      state: 'queued',
      controller: new AbortController(),
      subscribers: new Set<Subscriber>(),
    }
    jobs.set(key, job)
    pending.push(job)
  } else if (priority === 'visible' && job.state === 'queued') {
    job.priority = 'visible'
  }

  const target = job

  return new Promise<Blob>((resolve, reject) => {
    const subscriber: Subscriber = {
      signal,
      resolve,
      reject,
      onAbort() {
        if (!target.subscribers.delete(subscriber)) return

        signal.removeEventListener('abort', subscriber.onAbort)
        reject(abortError())

        if (target.subscribers.size === 0) {
          if (target.state === 'queued') {
            removePending(target)
            target.state = 'finished'
            forget(target)
          } else if (target.state === 'running') {
            target.controller.abort()
            forget(target)
          }
        }
      },
    }

    target.subscribers.add(subscriber)
    signal.addEventListener('abort', subscriber.onAbort, { once: true })

    if (signal.aborted) subscriber.onAbort()

    pump()
  })
}
