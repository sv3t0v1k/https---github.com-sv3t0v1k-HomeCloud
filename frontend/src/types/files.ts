export interface FileItem {
  id: number
  name: string
  size: string | number
  mimeType: string | null
  isDeleted: boolean
  isStarred: boolean
  parentId: number | null
  updatedAt: string
  deletedAt?: string | null
}

export interface FolderItem {
  id: number
  shareFileId: number
  name: string
  isDeleted: boolean
  parentId: number | null
  updatedAt: string
  deletedAt?: string | null
}

export interface TrashContents {
  files: FileItem[]
  folders: Omit<FolderItem, 'shareFileId'>[]
}

export interface FolderContents {
  files: FileItem[]
  folders: FolderItem[]
}
