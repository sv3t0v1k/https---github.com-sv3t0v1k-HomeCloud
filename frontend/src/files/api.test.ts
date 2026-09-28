import { AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it } from 'vitest'
import { apiClient } from '../api/client'
import { copyFile, createFolder, emptyTrash, getTrash, moveFolder, moveToTrash, permanentlyDelete, renameFile, restoreTrashItem } from './api'

describe('file operation API contracts', () => {
  afterEach(() => { apiClient.defaults.adapter = undefined })

  it('uses FolderEntity ids and exact mutation payloads', async () => {
    const requests: Array<{ method?: string; url?: string; data?: unknown }> = []
    apiClient.defaults.adapter = async (config) => {
      requests.push({ method: config.method, url: config.url, data: config.data ? JSON.parse(String(config.data)) : undefined })
      return ok(config, config.url === '/files/trash' ? { files: [], folders: [] } : {})
    }
    await createFolder('Docs', 7)
    await renameFile(11, 'report.txt')
    await moveFolder(7, null)
    await copyFile(11, 7)
    await moveToTrash('folder', 7)
    await restoreTrashItem('folder', 7)
    await permanentlyDelete('file', 11)
    await emptyTrash()
    await getTrash()
    expect(requests).toEqual([
      { method: 'post', url: '/files/folders', data: { name: 'Docs', parentId: 7 } },
      { method: 'patch', url: '/files/11', data: { name: 'report.txt' } },
      { method: 'patch', url: '/files/folders/7', data: { parentId: null } },
      { method: 'post', url: '/files/11/copy', data: { targetParentId: 7 } },
      { method: 'delete', url: '/files/folders/7', data: undefined },
      { method: 'post', url: '/files/folders/7/restore', data: undefined },
      { method: 'delete', url: '/files/11/permanent', data: undefined },
      { method: 'post', url: '/files/empty-trash', data: undefined },
      { method: 'get', url: '/files/trash', data: undefined },
    ])
  })
})

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}
