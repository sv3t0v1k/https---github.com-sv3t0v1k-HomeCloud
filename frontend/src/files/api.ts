import { apiRequest } from '../api/client'
import type { FileItem, FolderContents, FolderItem, TrashContents } from '../types/files'

export async function getFolderContents(
  parentId?: number,
  signal?: AbortSignal,
): Promise<FolderContents> {
  const params = parentId === undefined ? undefined : { parentId }
  const [folders, files] = await Promise.all([
    apiRequest<FolderItem[]>({ method: 'GET', url: '/files/folders', params, signal }),
    apiRequest<FileItem[]>({ method: 'GET', url: '/files', params, signal }),
  ])
  return { folders, files }
}

export function getFolder(folderId: number, signal?: AbortSignal) {
  return apiRequest<FolderItem>({
    method: 'GET',
    url: `/files/folders/${folderId}`,
    signal,
  })
}

export function createFolder(name: string, parentId?: number) {
  return apiRequest<FileItem>({ method: 'POST', url: '/files/folders', data: { name, ...(parentId === undefined ? {} : { parentId }) } })
}

export function renameFile(id: number, name: string) {
  return apiRequest<FileItem>({ method: 'PATCH', url: `/files/${id}`, data: { name } })
}

export function renameFolder(id: number, name: string) {
  return apiRequest<FileItem>({ method: 'PATCH', url: `/files/folders/${id}`, data: { name } })
}

export function moveFile(id: number, targetParentId?: number) {
  return apiRequest<FileItem>({ method: 'POST', url: `/files/${id}/move`, data: targetParentId === undefined ? {} : { targetParentId } })
}

export function moveFolder(id: number, parentId: number | null) {
  return apiRequest<FileItem>({ method: 'PATCH', url: `/files/folders/${id}`, data: { parentId } })
}

export function copyFile(id: number, targetParentId?: number) {
  return apiRequest<FileItem>({ method: 'POST', url: `/files/${id}/copy`, data: targetParentId === undefined ? {} : { targetParentId } })
}

export function moveToTrash(kind: 'file' | 'folder', id: number) {
  const prefix = kind === 'folder' ? '/files/folders' : '/files'
  return apiRequest<{ message: string }>({ method: 'DELETE', url: `${prefix}/${id}` })
}

export function getTrash(signal?: AbortSignal) {
  return apiRequest<TrashContents>({ method: 'GET', url: '/files/trash', signal })
}

export function restoreTrashItem(kind: 'file' | 'folder', id: number) {
  const prefix = kind === 'folder' ? '/files/folders' : '/files'
  return apiRequest<{ message: string }>({ method: 'POST', url: `${prefix}/${id}/restore` })
}

export function permanentlyDelete(kind: 'file' | 'folder', id: number) {
  const prefix = kind === 'folder' ? '/files/folders' : '/files'
  return apiRequest<{ message: string }>({ method: 'DELETE', url: `${prefix}/${id}/permanent` })
}

export function emptyTrash() {
  return apiRequest<{ message: string }>({ method: 'POST', url: '/files/empty-trash' })
}
