// Process-wide budget for completed thumbnail ObjectURLs.
// The browser may keep decoded image memory in addition to Blob bytes;
// bounding both count and encoded size limits retained resources.
export const MAX_RETAINED_THUMBNAILS = 96
export const MAX_RETAINED_THUMBNAIL_BYTES = 48 * 1024 * 1024

export type ThumbnailUrlLease = {
  readonly url: string
  touch(): void
  setVisible(visible: boolean): void
  release(): void
}

type Entry = {
  url: string
  size: number
  visible: boolean
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

function selectEvictionVictim(): symbol {
  const oldest = entries.keys().next().value
  if (!oldest) throw new Error('Thumbnail budget is empty')

  for (const [key, entry] of entries) {
    if (!entry.visible) return key
  }

  return oldest
}

export function retainThumbnailUrl(
  blob: Blob,
  onEvict: () => void,
  visible = false,
): ThumbnailUrlLease {
  if (
    !Number.isSafeInteger(blob.size) ||
    blob.size <= 0 ||
    blob.size > MAX_RETAINED_THUMBNAIL_BYTES
  ) {
    throw new RangeError('Thumbnail exceeds ObjectURL memory budget')
  }

  // Allocate before evicting old entries so a failed allocation does
  // not invalidate currently displayed thumbnails.
  const url = URL.createObjectURL(blob)

  // Evict before registering the new URL: it can never be returned
  // already revoked, even when all existing entries are visible.
  while (
    entries.size >= MAX_RETAINED_THUMBNAILS ||
    retainedBytes + blob.size > MAX_RETAINED_THUMBNAIL_BYTES
  ) {
    remove(selectEvictionVictim(), true)
  }

  const key = Symbol('thumbnail-url')
  entries.set(key, { url, size: blob.size, visible, onEvict })
  retainedBytes += blob.size

  return {
    url,
    touch() {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entries.set(key, entry)
    },
    setVisible(nextVisible: boolean) {
      const entry = entries.get(key)
      if (!entry) return
      entry.visible = nextVisible
    },
    release() {
      remove(key, false)
    },
  }
}
