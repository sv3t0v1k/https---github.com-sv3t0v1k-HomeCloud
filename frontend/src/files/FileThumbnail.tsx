import { useEffect, useRef, useState } from 'react'

import { tokenStorage } from '../auth/tokenStorage'
import { Icon } from '../ui/Icon'
import {
  retainThumbnailUrl,
  type ThumbnailUrlLease,
} from './thumbnailUrlBudget'
import {
  onThumbnailQueueCapacity,
  promoteThumbnail,
  queueThumbnail,
  ThumbnailQueuePressureError,
} from './thumbnailQueue'

export function FileThumbnail({ fileId }: { fileId: number }) {
  const element = useRef<HTMLSpanElement>(null)
  const objectUrl = useRef<ThumbnailUrlLease | null>(null)
  const inViewport = useRef(false)
  const visibleEvictionRetryUsed = useRef(false)

  const [shouldLoad, setShouldLoad] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  // The object URL belongs to the mounted file version, not
  // to the current intersection state.
  useEffect(() => {
    setUrl(null)
    visibleEvictionRetryUsed.current = false

    return () => {
      if (objectUrl.current) {
        objectUrl.current.release()
        objectUrl.current = null
      }
    }
  }, [fileId])

  useEffect(() => {
    const target = element.current
    if (!target) return

    if (typeof IntersectionObserver === 'undefined') {
      inViewport.current = true
      setShouldLoad(true)
      return
    }

    let nearby = false
    let visible = false

    const update = () => {
      setShouldLoad(nearby || visible)
    }

    // Prefetch starts shortly before the file enters the viewport.
    const prefetchObserver = new IntersectionObserver((entries) => {
      nearby = entries.some((entry) => entry.isIntersecting)
      if (nearby) objectUrl.current?.touch()
      update()
    }, { rootMargin: '160px' })

    // Actual visibility takes precedence over background prefetch.
    const viewportObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      const entered = visible && !inViewport.current
      inViewport.current = visible
      objectUrl.current?.setVisible(visible)

      if (!visible) {
        visibleEvictionRetryUsed.current = false
      }

      if (visible) {
        promoteThumbnail(fileId)
        objectUrl.current?.touch()

        // Also recover when prefetch stays active during viewport entry.
        if (entered && !objectUrl.current) {
          setReloadTick((tick) => tick + 1)
        }
      }
      update()
    }, { rootMargin: '0px' })

    prefetchObserver.observe(target)
    viewportObserver.observe(target)

    return () => {
      prefetchObserver.disconnect()
      viewportObserver.disconnect()
      inViewport.current = false
    }
  }, [fileId])

  useEffect(() => {
    if (!shouldLoad || objectUrl.current) return

    const controller = new AbortController()
    const ownerGeneration = tokenStorage.getOwnerGeneration()
    let mounted = true

    let stopWaiting: (() => void) | null = null

    const attempt = () => {
      if (
        !mounted ||
        controller.signal.aborted ||
        objectUrl.current ||
        tokenStorage.getOwnerGeneration() !== ownerGeneration
      ) return

      void queueThumbnail(
        fileId,
        controller.signal,
        inViewport.current ? 'visible' : 'prefetch',
      )
        .then((blob) => {
          if (
            !mounted ||
            controller.signal.aborted ||
            tokenStorage.getOwnerGeneration() !== ownerGeneration
          ) return

          let lease: ThumbnailUrlLease | null = null
          lease = retainThumbnailUrl(blob, () => {
            if (objectUrl.current !== lease) return

            objectUrl.current = null
            setUrl(null)

            // Exactly one automatic retry per continuous visibility.
            // Prevents an eviction/fetch storm when >96 items are visible.
            if (
              inViewport.current &&
              !visibleEvictionRetryUsed.current
            ) {
              visibleEvictionRetryUsed.current = true
              setReloadTick((tick) => tick + 1)
            }
          }, inViewport.current)

          if (
            !mounted ||
            controller.signal.aborted ||
            tokenStorage.getOwnerGeneration() !== ownerGeneration
          ) {
            lease.release()
            return
          }

          objectUrl.current = lease
          setUrl(lease.url)
        })
        .catch((error: unknown) => {
          if (
            !mounted ||
            controller.signal.aborted ||
            tokenStorage.getOwnerGeneration() !== ownerGeneration
          ) return

          if (error instanceof ThumbnailQueuePressureError) {
            // Subscribe once and retry only after pending capacity opens.
            stopWaiting = onThumbnailQueueCapacity(() => {
              stopWaiting?.()
              stopWaiting = null
              attempt()
            })
          } else {
            setUrl(null)
          }
        })
    }

    attempt()

    // Leaving both observer zones cancels queued or active fetching.
    // A completed thumbnail remains displayed until file unmount/version change.
    return () => {
      mounted = false
      stopWaiting?.()
      controller.abort()
    }
  }, [fileId, shouldLoad, reloadTick])

  return (
    <span
      className="file-icon file-icon-image file-thumbnail"
      data-thumbnail-status={url ? 'ready' : 'placeholder'}
      ref={element}
    >
      {url ? (
        <img
          alt=""
          aria-hidden="true"
          className="file-thumbnail-image"
          src={url}
        />
      ) : (
        <Icon name="image" />
      )}
    </span>
  )
}
