import { useEffect, useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { queueThumbnail } from './thumbnailQueue'

export function FileThumbnail({ fileId }: { fileId: number }) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px' })

    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return

    const controller = new AbortController()
    let objectUrl: string | null = null

    queueThumbnail(fileId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return

        const created = URL.createObjectURL(blob)

        if (controller.signal.aborted) {
          URL.revokeObjectURL(created)
          return
        }

        objectUrl = created
        setUrl(created)
      })
      .catch(() => {
        if (!controller.signal.aborted) setUrl(null)
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId, visible])

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
