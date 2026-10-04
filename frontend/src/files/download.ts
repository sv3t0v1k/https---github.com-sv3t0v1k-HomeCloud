import { API_BASE_URL, apiRequest } from '../api/client'
import type { FileItem } from '../types/files'

// Only tiny JSON capability preparation enters JavaScript. The file response
// belongs to the browser download manager, never Axios/Blob/object URLs.
export async function downloadOriginalFile(file: Pick<FileItem, 'id' | 'name' | 'size'>): Promise<void> {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size')
  const result = await apiRequest<{ downloadPath: string }>({ method: 'POST', url: `/native-downloads/${file.id}/prepare`, withCredentials: true })
  if (result.downloadPath !== `/native-downloads/${file.id}`) throw new Error('Invalid download endpoint')
  const anchor = document.createElement('a')
  anchor.href = nativeDownloadUrl(result.downloadPath)
  anchor.target = nativeDownloadTarget()
  anchor.rel = 'noreferrer'
  anchor.style.display = 'none'
  document.body.append(anchor)
  try { anchor.click() } finally { anchor.remove() }
}

export function nativeDownloadUrl(path: string): string {
  const url = new URL(`${API_BASE_URL.replace(/\/$/, '')}${path}`, window.location.href)
  // Cookie scope and Strict SameSite require the deployed frontend/API origin.
  if (url.origin !== window.location.origin) throw new Error('Native downloads require a same-origin API')
  return url.href
}

export function nativeDownloadTarget(): string {
  const name = 'homecloud-native-download'
  if (!document.getElementById(name)) {
    const frame = document.createElement('iframe')
    frame.id = name; frame.name = name; frame.hidden = true
    frame.title = 'Загрузки браузера'
    document.body.append(frame)
  }
  return name
}
