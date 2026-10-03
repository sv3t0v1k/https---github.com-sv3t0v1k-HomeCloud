import { apiRequest, API_BASE_URL } from '../api/client'
import { ApiError } from '../api/errors'
import { MAX_BROWSER_BLOB_DOWNLOAD_BYTES, BrowserDownloadLimitError } from '../files/download'

export interface PublicResource { name: string; size: string | number | null; mimeType: string | null }
export interface PublicShare { resource?: PublicResource; fileId: number; isFolder: boolean; requiresPassword: boolean; expiresAt: string | null }
export interface SharedChild { id: number; name: string; kind: 'file' | 'folder'; size: string | number | null }
export interface SharedChildren { parentId: number; items: SharedChild[]; offset: number; limit: number; hasMore: boolean }
const path = (token: string) => `/sharing/public/${encodeURIComponent(token)}`
export function getPublicShare(token: string, signal?: AbortSignal) {
  return apiRequest<PublicShare>({ url: path(token), signal, skipAuth: true, skipRefresh: true })
}
export function verifyPublicShare(token: string, password: string, signal?: AbortSignal) {
  return apiRequest<{ success: boolean; resource?: PublicResource }>({ method: 'POST', url: `${path(token)}/verify`, data: { password }, signal, skipAuth: true, skipRefresh: true })
}
export function getSharedChildren(token: string, password: string, parentId?: number, offset = 0, signal?: AbortSignal) {
  return apiRequest<SharedChildren>({ url: `${path(token)}/children`, params: { parentId, offset, limit: 50 }, headers: password ? { 'x-share-password': password } : {}, signal, skipAuth: true, skipRefresh: true })
}

// Public POST downloads keep passwords out of URLs. Bound streamed buffering to
// the same browser limit used for authenticated downloads, including ZIP files.
export async function downloadPublicShare(token: string, password: string, fileId?: number, name?: string, signal?: AbortSignal) {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}${path(token)}/download`, {
    method: 'POST', signal, credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, ...(fileId === undefined ? {} : { fileId }) }),
  })
  if (!response.ok) throw new ApiError('Public download failed', 'server', response.status)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Download stream unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BROWSER_BLOB_DOWNLOAD_BYTES) throw new BrowserDownloadLimitError()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError')
  const url = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' }))
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = name || /filename="([^"]*)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'download'
    document.body.append(anchor); anchor.click()
  } finally { anchor.remove(); URL.revokeObjectURL(url) }
}
