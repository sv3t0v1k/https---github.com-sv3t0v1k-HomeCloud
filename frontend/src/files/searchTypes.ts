export interface SearchFile {
  id: number
  name: string
  parentId: number | null
  size: string | number
  mimeType: string | null
  isStarred: boolean
  createdAt: string
  updatedAt: string
}

export interface SearchFolder {
  id: number
  name: string
  parentId: number | null
  shareFileId: number
  createdAt: string
  updatedAt: string
}

export interface SearchPage {
  files: SearchFile[]
  folders: SearchFolder[]
  limit: number
  offset: number
  hasMore: boolean
}
