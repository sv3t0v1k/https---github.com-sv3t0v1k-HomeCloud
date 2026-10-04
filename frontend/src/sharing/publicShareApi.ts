import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import { nativeDownloadTarget, nativeDownloadUrl } from '../files/download'

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

// Native form POST keeps the password in the request body and streams the
// existing public file/ZIP response directly into the browser download manager.
export async function downloadPublicShare(token: string, password: string, fileId?: number, _name?: string, signal?: AbortSignal) {
  if (password) {
    const verified = await verifyPublicShare(token, password, signal)
    if (!verified.success) throw new ApiError('Share verification failed', 'authorization', 403)
  } else {
    await getPublicShare(token, signal)
  }
  if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError')
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = nativeDownloadUrl(`${path(token)}/download`)
  form.target = nativeDownloadTarget()
  form.style.display = 'none'
  for (const [name, value] of Object.entries({ password, ...(fileId === undefined ? {} : { fileId: String(fileId) }) })) {
    const input = document.createElement('input')
    input.type = 'hidden'; input.name = name; input.value = value
    form.append(input)
  }
  document.body.append(form)
  try { form.submit() } finally { form.remove() }
}
