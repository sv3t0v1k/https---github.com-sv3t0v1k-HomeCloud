// Process-wide budget for completed thumbnail ObjectURLs.
// The browser may keep decoded image memory in addition to Blob bytes;
// bounding both count and encoded size limits retained resources.
export const MAX_RETAINED_THUMBNAILS = 96
export const MAX_RETAINED_THUMBNAIL_BYTES = 48 * 1024 * 1024

export type ThumbnailUrlLease = {
  readonly url: string
  touch(): void
  release(): void
}

type Entry = {
  url: string
  size: number
  onEvict: () => void
}

const entries = new Map<symbol, Entry>()
let retainedBytes = 0

function remove(key: symbol, notify: boolean) {
  const entry = entries.get(key)
  if (!entry) return

  entries.delete(key)
  retainedBytes -= entry.size
  URL.revokeObjectURL(entry.url)

  if (notify) entry.onEvict()
}

export function retainThumbnailUrl(
  blob: Blob,
  onEvict: () => void,
): ThumbnailUrlLease {
  if (
    !Number.isSafeInteger(blob.size) ||
    blob.size <= 0 ||
    blob.size > MAX_RETAINED_THUMBNAIL_BYTES
  ) {
    throw new RangeError('Thumbnail exceeds ObjectURL memory budget')
  }

  const key = Symbol('thumbnail-url')
  const url = URL.createObjectURL(blob)

  entries.set(key, { url, size: blob.size, onEvict })
  retainedBytes += blob.size

  // Map insertion order is our LRU. Most recently used entries are last.
  while (
    entries.size > MAX_RETAINED_THUMBNAILS ||
    retainedBytes > MAX_RETAINED_THUMBNAIL_BYTES
  ) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    remove(oldest, true)
  }

  return {
    url,
    touch() {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entries.set(key, entry)
    },
    release() {
      remove(key, false)
    },
  }
}
