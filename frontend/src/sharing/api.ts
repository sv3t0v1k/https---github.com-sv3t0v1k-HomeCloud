import { API_BASE_URL, apiRequest } from '../api/client'

export interface ShareTarget {
  fileId: number
  name: string
  isFolder: boolean
}

export interface OwnerShare {
  id: number
  token: string
  fileId: number
  isFolder: boolean
  isActive: boolean
  expiresAt: string | null
  downloadCount: string | number
  maxDownloads: string | number | null
  createdAt: string
  updatedAt: string
  file?: { id: number; name: string; isFolder: boolean; folderId: number | null }
}

export interface CreateShareInput {
  fileId: number
  isFolder: boolean
  password?: string
  expiresInDays?: number
  maxDownloads?: number
}

export function listShares(signal?: AbortSignal) {
  return apiRequest<OwnerShare[]>({ method: 'GET', url: '/sharing', signal })
}

export function createShare(input: CreateShareInput) {
  return apiRequest<OwnerShare>({ method: 'POST', url: '/sharing', data: input })
}

export function revokeShare(id: number) {
  return apiRequest<{ message: string }>({ method: 'DELETE', url: `/sharing/${id}` })
}

export function publicShareUrl(token: string): string {
  const base = API_BASE_URL.replace(/\/$/, '')
  return new URL(`${base}/sharing/public/${encodeURIComponent(token)}`, window.location.origin).toString()
}
