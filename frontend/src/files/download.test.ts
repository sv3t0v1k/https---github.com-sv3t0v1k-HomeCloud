import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'
import { downloadOriginalFile, downloadSelectionArchive } from './download'

afterEach(() => { tokenStorage.clear(); apiClient.defaults.adapter = undefined; vi.restoreAllMocks(); document.getElementById('homecloud-native-download')?.remove() })
describe('native authenticated download', () => {
  it.each([1, 100 * 1024 ** 2 + 1, 53687091200])('hands %s bytes to the browser with no response buffering or URL secrets', async (size) => {
    tokenStorage.set({ accessToken: 'owner-secret', refreshToken: 'refresh-secret' })
    const requests: unknown[] = []
    apiClient.defaults.adapter = async (config) => {
      requests.push({ method: config.method, url: config.url, auth: config.headers.Authorization, responseType: config.responseType, credentials: config.withCredentials })
      return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { downloadPath: '/native-downloads/42' } } }
    }
    let href = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { href = this.href; expect(this.target).toBe('') })
    await downloadOriginalFile({ id: 42, name: 'large.bin', size: String(size) })
    expect(requests).toEqual([{ method: 'post', url: '/native-downloads/42/prepare', auth: 'Bearer owner-secret', responseType: undefined, credentials: true }])
    expect(new URL(href).pathname).toBe('/api/v1/native-downloads/42')
    expect(new URL(href).search).toBe('')
    expect(href).not.toContain('secret')
    expect(document.querySelector('a')).toBeNull()
    expect(document.getElementById('homecloud-native-download')).toBeNull()
  })
  it('rejects an unexpected resource endpoint before native navigation', async () => {
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { data: { downloadPath: '/native-downloads/99' } } })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    await expect(downloadOriginalFile({ id: 42, name: 'private.bin', size: 1 })).rejects.toThrow('Invalid download endpoint')
    expect(click).not.toHaveBeenCalled()
  })

  it('prepares one mixed ZIP and hands its opaque same-origin URL to the browser', async () => {
    tokenStorage.set({ accessToken: 'owner-secret', refreshToken: 'refresh-secret' })
    const requests: unknown[] = []
    const capability = '0123456789abcdef0123456789abcdef'
    apiClient.defaults.adapter = async (config) => {
      requests.push({ method: config.method, url: config.url, data: JSON.parse(String(config.data)), auth: config.headers.Authorization, responseType: config.responseType, credentials: config.withCredentials })
      return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { downloadPath: `/native-download-archives/${capability}` } } }
    }
    let href = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { href = this.href; expect(this.target).toBe('') })
    await downloadSelectionArchive([{ kind: 'folder', id: 7 }, { kind: 'file', id: 42 }])
    expect(requests).toEqual([{ method: 'post', url: '/files/download-archives/prepare', data: { items: [{ kind: 'folder', id: 7 }, { kind: 'file', id: 42 }] }, auth: 'Bearer owner-secret', responseType: undefined, credentials: true }])
    expect(new URL(href).pathname).toBe(`/api/v1/native-download-archives/${capability}`)
    expect(new URL(href).search).toBe('')
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
  })

  it.each(['/native-download-archives/../files/42', 'https://attacker.example/zip', '/native-download-archives/123?token=secret'])('rejects unexpected ZIP destination %s', async (downloadPath) => {
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { downloadPath } } })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    await expect(downloadSelectionArchive([{ kind: 'file', id: 1 }, { kind: 'file', id: 2 }])).rejects.toThrow('Invalid archive download endpoint')
    expect(click).not.toHaveBeenCalled()
  })
})
