import { afterEach, describe, expect, it } from 'vitest'
import { AxiosHeaders } from 'axios'
import { apiClient } from '../api/client'
import { normalizeSearchQuery, parseSearchLocation, searchFiles, searchRetryAfter } from './searchApi'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => { apiClient.defaults.adapter = originalAdapter })

describe('search input and API boundary', () => {
  it('uses the safe endpoint envelope, fixed page size and AbortSignal', async () => {
    const controller = new AbortController()
    apiClient.defaults.adapter = async (config) => {
      expect(config.url).toBe('/files/search')
      expect(config.method).toBe('get')
      expect(config.params).toEqual({ q: '100%_!', limit: 20, offset: 40 })
      expect(config.signal).toBe(controller.signal)
      return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data: { files: [], folders: [], limit: 20, offset: 40, hasMore: false } } }
    }
    await expect(searchFiles(' 100%_! ', 40, controller.signal)).resolves.toMatchObject({ limit: 20, offset: 40 })
  })

  it.each(['', 'x', 'x'.repeat(101), 'ab\ncd', 'ab\u0000cd', 'ab\u007fcd'])(
    'rejects invalid input before the network: %j', async (query) => {
      apiClient.defaults.adapter = async () => { throw new Error('Must not reach API') }
      expect(normalizeSearchQuery(query)).toBeNull()
      await expect(searchFiles(query)).rejects.toMatchObject({ status: 400, kind: 'validation' })
    },
  )

  it.each([-1, 10001, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects offset %s before the network', async (offset) => {
    await expect(searchFiles('report', offset)).rejects.toMatchObject({ status: 400 })
  })

  it.each([
    'q=ab&q=cd', 'q[x]=ab', 'q=ab&offset=01', 'q=ab&offset=-1',
    'q=ab&offset=10001', 'q=ab&offset=2.5', 'q=ab&offset=1&offset=2',
    'q=ab&limit=50', 'q=ab&limit=20&limit=20', 'q=ab&userId=2', 'offset=0', 'q=',
  ])('rejects an ambiguous/invalid URL %s', (value) => {
    expect(parseSearchLocation(new URLSearchParams(value))).toMatchObject({ query: null, error: expect.any(String) })
  })

  it('handles an idle URL and trims a valid bookmarked query', () => {
    expect(parseSearchLocation(new URLSearchParams())).toEqual({ query: null, offset: 0, error: null })
    expect(parseSearchLocation(new URLSearchParams('q=%20Привет%20&offset=10000&limit=20'))).toEqual({ query: 'Привет', offset: 10000, error: null })
  })

  it('parses Retry-After seconds/date and fails closed for invalid values', () => {
    const now = Date.parse('2026-11-07T00:00:00Z')
    expect(searchRetryAfter('12', now)).toBe(now + 12000)
    expect(searchRetryAfter('0', now)).toBe(now)
    expect(searchRetryAfter('Sat, 07 Nov 2026 00:00:20 GMT', now)).toBe(now + 20000)
    for (const value of [undefined, 'invalid', '-1', '9999999999999999', 'Fri, 06 Nov 2026 00:00:00 GMT']) {
      expect(searchRetryAfter(value, now)).toBe(now + 60000)
    }
  })
})
