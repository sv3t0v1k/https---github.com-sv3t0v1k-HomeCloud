import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'
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
  it('submits native POST with password in its body and no file buffering', async () => {
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { data: { success: true } } })
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    let action = ''; let body: FormData | undefined
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      action = this.action; body = new FormData(this); expect(this.method).toBe('post'); expect(this.target).toBe('homecloud-native-download')
    })
    await downloadPublicShare('token', 'private-password', 7)
    expect(new URL(action).pathname).toBe('/api/v1/sharing/public/token/download')
    expect(new URL(action).search).toBe('')
    expect(body?.get('password')).toBe('private-password'); expect(body?.get('fileId')).toBe('7')
    expect(fetchMock).not.toHaveBeenCalled(); expect(document.querySelector('form')).toBeNull()
  })
  it('downloads passwordless shares without calling password verification', async () => {
    const requests: string[] = []
    apiClient.defaults.adapter = async (config) => { requests.push(config.url || ''); return { config, status: 200, statusText: 'OK', headers: {}, data: { data: { requiresPassword: false, fileId: 7 } } } }
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    await downloadPublicShare('open-token', '')
    expect(requests).toEqual(['/sharing/public/open-token'])
    expect(submit).toHaveBeenCalledOnce()
  })
  it('rejects failed verification before native handoff', async () => {
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { data: { success: false } } })
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit')
    await expect(downloadPublicShare('token', 'wrong')).rejects.toMatchObject({ status: 403 })
    expect(submit).not.toHaveBeenCalled()
  })
})
