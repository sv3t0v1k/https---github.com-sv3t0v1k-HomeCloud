export interface File {
  id: string
  name: string
  path: string
  size: number
  mime_type: string
  created_at: string
  updated_at: string
  owner_id: string
  folder_id?: string
}

export interface Folder {
  id: string
  name: string
  path: string
  parent_id?: string
  created_at: string
  updated_at: string
  owner_id: string
}

export interface StorageInfo {
  used: number
  total: number
  files_count: number
  folders_count: number
}
