import { apiRequest } from '../api/client'
import type { FileItem, FolderContents, FolderItem } from '../types/files'

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
