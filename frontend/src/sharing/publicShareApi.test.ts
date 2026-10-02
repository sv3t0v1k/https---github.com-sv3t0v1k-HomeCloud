import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'
import { BrowserDownloadLimitError, MAX_BROWSER_BLOB_DOWNLOAD_BYTES } from '../files/download'
import { downloadPublicShare, getPublicShare, getSharedChildren, verifyPublicShare } from './publicShareApi'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); tokenStorage.clear(); apiClient.defaults.adapter = undefined })
describe('public sharing transport', () => {
  it('never sends owner authorization or exposes password in query strings', async () => {
    tokenStorage.set({ accessToken: 'owner-secret', refreshToken: 'owner-refresh' })
    const calls: unknown[] = []
    apiClient.defaults.adapter = async (config) => {
      calls.push({ url: config.url, data: config.data, params: config.params, password: config.headers['x-share-password'], authorization: config.headers.Authorization, skipRefresh: config.skipRefresh })
      return { data: { success: true, data: { success: true } }, status: 200, statusText: 'OK', headers: {}, config }
    }
    await getPublicShare('token'); await verifyPublicShare('token', 'private-password'); await getSharedChildren('token', 'private-password', 12, 50)
    expect(calls).toEqual([
      { url: '/sharing/public/token', data: undefined, params: undefined, password: undefined, authorization: undefined, skipRefresh: true },
      { url: '/sharing/public/token/verify', data: '{"password":"private-password"}', params: undefined, password: undefined, authorization: undefined, skipRefresh: true },
      { url: '/sharing/public/token/children', data: undefined, params: { parentId: 12, offset: 50, limit: 50 }, password: 'private-password', authorization: undefined, skipRefresh: true },
    ])
  })
  it('saves actual streamed bytes and server filename, with password in POST body only', async () => {
    const bytes = new TextEncoder().encode('download evidence')
    const read = vi.fn().mockResolvedValueOnce({ done: false, value: bytes }).mockResolvedValueOnce({ done: true })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="evidence.txt"' }), body: { getReader: () => ({ read, releaseLock: vi.fn(), cancel: vi.fn() }) } })
    vi.stubGlobal('fetch', fetchMock)
    let blob!: Blob
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => { blob = value; return 'blob:test' }), revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('evidence.txt') })
    await downloadPublicShare('token', 'private-password')
    expect(blob.size).toBe(bytes.length); expect(click).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sharing/public/token/download', { method: 'POST', signal: undefined, credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: '{"password":"private-password"}' })
  })
  it('cancels oversized buffered downloads and displays no save action', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined); const releaseLock = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: false, value: { byteLength: MAX_BROWSER_BLOB_DOWNLOAD_BYTES + 1 } }), cancel, releaseLock }) } }))
    await expect(downloadPublicShare('token', '')).rejects.toBeInstanceOf(BrowserDownloadLimitError)
    expect(cancel).toHaveBeenCalledTimes(1); expect(releaseLock).toHaveBeenCalledTimes(1)
  })
  it('reports failed downloads without buffering backend bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(downloadPublicShare('token', '')).rejects.toMatchObject({ status: 404 })
  })
})
