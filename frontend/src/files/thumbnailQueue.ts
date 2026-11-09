import { fetchFileThumbnail } from './thumbnailApi'

const MAX_CONCURRENT = 4

type Job = { run(): void }
const pending: Job[] = []
let active = 0

function pump() {
  while (active < MAX_CONCURRENT && pending.length) {
    pending.shift()?.run()
  }
}

export function queueThumbnail(
  fileId: number,
  signal: AbortSignal,
): Promise<Blob> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  }

  return new Promise<Blob>((resolve, reject) => {
    let state: 'queued' | 'running' | 'finished' = 'queued'

    function cancelQueued() {
      if (state !== 'queued') return
      state = 'finished'
      const index = pending.indexOf(job)
      if (index >= 0) pending.splice(index, 1)
      signal.removeEventListener('abort', cancelQueued)
      reject(new DOMException('Cancelled', 'AbortError'))
    }

    const job: Job = {
      run() {
        if (state !== 'queued') return
        if (signal.aborted) {
          cancelQueued()
          return
        }

        state = 'running'
        signal.removeEventListener('abort', cancelQueued)
        active += 1

        fetchFileThumbnail(fileId, signal)
          .then(resolve, reject)
          .finally(() => {
            state = 'finished'
            active -= 1
            pump()
          })
      },
    }

    signal.addEventListener('abort', cancelQueued, { once: true })
    pending.push(job)
    pump()
  })
}
