import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'
import { downloadOriginalFile } from './download'

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
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { href = this.href; expect(this.target).toBe('homecloud-native-download') })
    await downloadOriginalFile({ id: 42, name: 'large.bin', size: String(size) })
    expect(requests).toEqual([{ method: 'post', url: '/native-downloads/42/prepare', auth: 'Bearer owner-secret', responseType: undefined, credentials: true }])
    expect(new URL(href).pathname).toBe('/api/v1/native-downloads/42')
    expect(new URL(href).search).toBe('')
    expect(href).not.toContain('secret')
    expect(document.querySelector('a')).toBeNull()
  })
  it('rejects an unexpected resource endpoint before native navigation', async () => {
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { data: { downloadPath: '/native-downloads/99' } } })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    await expect(downloadOriginalFile({ id: 42, name: 'private.bin', size: 1 })).rejects.toThrow('Invalid download endpoint')
    expect(click).not.toHaveBeenCalled()
  })
})
