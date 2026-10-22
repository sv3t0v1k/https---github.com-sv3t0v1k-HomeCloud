import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { PublicUploadTransport } from './publicUploadTransport'
vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
const request = vi.mocked(apiRequest)
beforeEach(() => request.mockReset())
describe('public upload transport', () => {
  it('shares memory-only proof, scopes all calls, and never discovers owner sessions', async () => {
    request.mockResolvedValue({ proof: 'proof', expiresAt: new Date(Date.now() + 300_000).toISOString() })
    const transport = new PublicUploadTransport('token', 'secret')
    await Promise.all([transport.authorize(), transport.authorize()])
    await transport.request({ method: 'GET', url: '/uploads/session/id' })
    await transport.mkdir(4, 'folder', 'key')
    expect(request.mock.calls).toHaveLength(3)
    for (const [config] of request.mock.calls) {
      expect(config.url).toMatch(/^\/sharing\/public\/token\//)
      expect(config.skipAuth).toBe(true); expect(config.skipRefresh).toBe(true)
      expect(config.url).not.toContain('password')
    }
    expect(request.mock.calls[1][0].headers).toMatchObject({ 'X-Share-Upload-Proof': 'proof' })
    expect(localStorage.length).toBe(0)
    await expect(transport.request({ url: '/uploads/sessions' })).rejects.toThrow()
    transport.dispose()
    await expect(transport.authorize()).rejects.toThrow()
  })
  it('renews expired proof before another operation without changing idempotency payload', async () => {
    request.mockResolvedValueOnce({ proof: 'old', expiresAt: new Date(Date.now() - 1).toISOString() })
      .mockResolvedValueOnce({ proof: 'new', expiresAt: new Date(Date.now() + 300_000).toISOString() })
      .mockResolvedValueOnce({ id: 5, name: 'x' })
    const transport = new PublicUploadTransport('t', 'p')
    await transport.authorize(); await transport.mkdir(4, 'x', 'same')
    expect(request.mock.calls[2][0]).toMatchObject({ data: { parentId: 4, name: 'x' }, headers: { 'Idempotency-Key': 'same', 'X-Share-Upload-Proof': 'new' } })
  })
})
