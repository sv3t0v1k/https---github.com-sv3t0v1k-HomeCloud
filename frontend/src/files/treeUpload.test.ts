import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFolder } from './api'
import { enqueueTree } from './treeUpload'
import type { UploadQueue } from './uploadQueue'
vi.mock('./api', () => ({ createFolder: vi.fn() }))
afterEach(() => vi.clearAllMocks())
const file = new File(['content'], 'leaf.txt')
function queue() { return { enqueue: vi.fn() } as unknown as UploadQueue }
describe('private folder upload through the existing queue', () => {
  it('creates empty folders and nested parents before queuing bytes into their actual IDs', async () => {
    const q = queue()
    vi.mocked(createFolder).mockResolvedValueOnce({ id: 300, folderId: 30 } as never).mockResolvedValueOnce({ id: 310, folderId: 31 } as never)
    await enqueueTree([{ kind: 'folder', path: 'root/empty' }, { kind: 'file', path: 'root/leaf.txt', file }], q, 9)
    expect(createFolder).toHaveBeenNthCalledWith(1, 'root', 9)
    expect(createFolder).toHaveBeenNthCalledWith(2, 'empty', 30)
    expect(q.enqueue).toHaveBeenCalledExactlyOnceWith([file], 30)
  })
  it('does not flatten the tree or automatically retry an ambiguous mkdir error', async () => {
    const q = queue()
    vi.mocked(createFolder).mockResolvedValueOnce({ id: 300, folderId: 30 } as never).mockRejectedValueOnce(new Error('lost response'))
    await expect(enqueueTree([{ kind: 'file', path: 'root/child/leaf.txt', file }], q)).rejects.toThrow('lost response')
    expect(createFolder).toHaveBeenCalledTimes(2)
    expect(q.enqueue).not.toHaveBeenCalled()
  })
  it('never uses a mirror file ID when a folder response is missing folderId', async () => {
    const q = queue()
    vi.mocked(createFolder).mockResolvedValueOnce({ id: 300 } as never)
    await expect(enqueueTree([{ kind: 'file', path: 'root/leaf.txt', file }], q)).rejects.toThrow('не подтвердил папку')
    expect(q.enqueue).not.toHaveBeenCalled()
  })
  it('stops further writes when the authenticated workspace is disposed', async () => {
    const q = queue()
    await enqueueTree([{ kind: 'file', path: 'leaf.txt', file }], q, 9, () => false)
    expect(q.enqueue).not.toHaveBeenCalled()
  })
})
