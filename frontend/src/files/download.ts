import { apiClient } from '../api/client'
import { normalizeApiError } from '../api/errors'
import type { FileItem } from '../types/files'

// Axios has to buffer the response into a Blob so it can attach the bearer
// token. Keep this deliberately conservative until the backend offers a
// short-lived URL (or another authenticated native-navigation mechanism).
export const MAX_BROWSER_BLOB_DOWNLOAD_BYTES = 100 * 1024 * 1024

export class BrowserDownloadLimitError extends Error {
  readonly code = 'browser-download-limit'

  constructor(readonly maximumBytes = MAX_BROWSER_BLOB_DOWNLOAD_BYTES) {
    super('This file is too large for browser download in the current version.')
    this.name = 'BrowserDownloadLimitError'
  }
}

export async function downloadOriginalFile(
  file: Pick<FileItem, 'id' | 'name' | 'size'>,
): Promise<void> {
  const size = parseFileSize(file.size)
  if (size > MAX_BROWSER_BLOB_DOWNLOAD_BYTES) {
    throw new BrowserDownloadLimitError()
  }

  try {
    const response = await apiClient.get<Blob>(`/files/${file.id}/download`, {
      responseType: 'blob',
    })
    const objectUrl = URL.createObjectURL(response.data)

    try {
      const anchor = document.createElement('a')
      try {
        anchor.href = objectUrl
        anchor.download = file.name
        anchor.style.display = 'none'
        document.body.append(anchor)
        anchor.click()
      } finally {
        anchor.remove()
      }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch (error) {
    if (error instanceof BrowserDownloadLimitError) throw error
    throw normalizeApiError(error)
  }
}

function parseFileSize(value: string | number): number {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new BrowserDownloadLimitError()
  }
  return size
}
