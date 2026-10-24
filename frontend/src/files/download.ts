import { API_BASE_URL, apiRequest } from '../api/client'
import type { FileItem } from '../types/files'

// Only tiny JSON capability preparation enters JavaScript. The file response
// belongs to the browser download manager, never Axios/Blob/object URLs.
export async function downloadOriginalFile(file: Pick<FileItem, 'id' | 'name' | 'size'>): Promise<void> {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size')
  const result = await apiRequest<{ downloadPath: string }>({ method: 'POST', url: `/native-downloads/${file.id}/prepare`, withCredentials: true })
  if (result.downloadPath !== `/native-downloads/${file.id}`) throw new Error('Invalid download endpoint')
  handOffToBrowser(result.downloadPath)
}

export type ArchiveSelection = { kind: 'file' | 'folder'; id: number }

export async function downloadSelectionArchive(items: ArchiveSelection[]): Promise<void> {
  if (items.length < 2 || items.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !['file', 'folder'].includes(item.kind))) {
    throw new RangeError('Invalid archive selection')
  }
  const result = await apiRequest<{ downloadPath: string }>({
    method: 'POST', url: '/files/download-archives/prepare', data: { items }, withCredentials: true,
  })
  // Accept only an opaque archive capability on the expected native endpoint.
  // Do not let an unexpected server response navigate the browser elsewhere.
  if (!/^\/native-download-archives\/[a-f0-9]{32}$/.test(result.downloadPath)) throw new Error('Invalid archive download endpoint')
  handOffToBrowser(result.downloadPath)
}

function handOffToBrowser(path: string): void {
  const anchor = document.createElement('a')
  anchor.href = nativeDownloadUrl(path)
  // Attachment responses must navigate at the top level. The ingress forbids
  // framing, so an iframe can consume the one-time capability without saving.
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
