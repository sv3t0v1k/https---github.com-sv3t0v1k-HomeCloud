import { createFolder } from './api'
import type { UploadQueue } from './uploadQueue'
import { manifest, type TreeEntry } from '../sharing/publicTree'

/** Folders use the existing API; all file bytes go through the one UploadQueue. */
export async function enqueueTree(entries: TreeEntry[], queue: UploadQueue, parentId?: number, alive = () => true, onFolder = () => {}) {
  const nodes = manifest(entries)
  if (!nodes.length) throw new Error('Браузер не передал содержимое папки. Пустую папку можно создать через «Добавить».')
  const parents = new Map<string, number | undefined>([['', parentId]])
  let changed = false
  try {
    for (const node of nodes) {
      if (!alive()) return
      const path = node.path.split('/')
      const name = path.pop()!
      const target = parents.get(path.join('/'))
      if (node.kind === 'folder') {
        // Private mkdir returns a file mirror. Only folderId is a valid parent.
        // No automatic retry: this API has no idempotency key.
        const folder = await createFolder(name, target)
        changed = true
        if (!Number.isSafeInteger(folder.folderId) || folder.folderId <= 0) throw new Error('Сервер не подтвердил папку назначения. Проверьте созданные объекты перед повтором.')
        parents.set(node.path, folder.folderId)
      } else if (node.file) {
        queue.enqueue([node.file.name === name ? node.file : new File([node.file], name, { type: node.file.type, lastModified: node.file.lastModified })], target)
      }
    }
  } finally {
    if (changed && alive()) onFolder()
  }
}
