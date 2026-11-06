import { AxiosError, AxiosHeaders } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { resolveSearchPath, type PathCache } from './searchPath'

const adapter = apiClient.defaults.adapter
beforeEach(() => { apiClient.defaults.adapter = undefined })
afterEach(() => { apiClient.defaults.adapter = adapter; vi.restoreAllMocks() })

describe('selected result path through the folder API', () => {
  it('follows only the selected ancestry, reuses fresh nodes and expires them', async () => {
    let now = 100000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const calls: string[] = []
    apiClient.defaults.adapter = async config => {
      calls.push(config.url!)
      const id = Number(config.url?.split('/').pop())
      return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data: { id, name: `Folder ${id}`, parentId: id === 7 ? 3 : null } } }
    }
    const cache: PathCache = new Map()
    const signal = new AbortController().signal
    await expect(resolveSearchPath(7, cache, signal)).resolves.toEqual([{ id: 3, name: 'Folder 3' }, { id: 7, name: 'Folder 7' }])
    await expect(resolveSearchPath(7, cache, signal)).resolves.toHaveLength(2)
    expect(calls).toEqual(['/files/folders/7', '/files/folders/3'])
    now += 61000
    await resolveSearchPath(7, cache, signal)
    expect(calls).toEqual(['/files/folders/7', '/files/folders/3', '/files/folders/7', '/files/folders/3'])
  })

  it('returns the root without a request and rejects an already aborted resolution', async () => {
    apiClient.defaults.adapter = async () => { throw new Error('No API expected') }
    await expect(resolveSearchPath(null, new Map(), new AbortController().signal)).resolves.toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(resolveSearchPath(7, new Map(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects cycles without enumerating the tree indefinitely', async () => {
    const calls: string[] = []
    apiClient.defaults.adapter = async config => {
      calls.push(config.url!)
      const id = Number(config.url?.split('/').pop())
      return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { data: { id, name: 'cyclic', parentId: id === 7 ? 3 : 7 } } }
    }
    await expect(resolveSearchPath(7, new Map(), new AbortController().signal)).rejects.toMatchObject({ status: 400 })
    expect(calls).toEqual(['/files/folders/7', '/files/folders/3'])
  })

  it('does not retain an ancestor fetched after cancellation', async () => {
    let finish!: () => void
    const controller = new AbortController()
    apiClient.defaults.adapter = async config => new Promise(resolve => {
      finish = () => resolve({ config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { data: { id: 7, name: 'private ancestor', parentId: null } } })
    })
    const cache: PathCache = new Map()
    const pending = resolveSearchPath(7, cache, controller.signal)
    // Axios starts the adapter after its request interceptor.
    await new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(resolve)))
    controller.abort()
    finish()
    await expect(pending).rejects.toBeDefined()
    expect(cache.size).toBe(0)
  })

  it('bounds a deep cached chain without additional requests', async () => {
    const cache: PathCache = new Map()
    for (let id = 1; id <= 257; id++) cache.set(id, { id, name: `Folder ${id}`, parentId: id + 1, at: Date.now() })
    apiClient.defaults.adapter = async () => { throw new Error('No API expected') }
    await expect(resolveSearchPath(1, cache, new AbortController().signal)).rejects.toMatchObject({ status: 400 })
  })

  it.each([{ id: 8, name: 'wrong', parentId: null }, { id: 7, name: null, parentId: null }, { id: 7, name: 'bad parent', parentId: -1 }])(
    'rejects a mismatched or malformed folder DTO', async data => {
      apiClient.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { data } })
      await expect(resolveSearchPath(7, new Map(), new AbortController().signal)).rejects.toMatchObject({ status: 400 })
    },
  )

  it.each([403, 404])('propagates HTTP %s on an ancestor without inventing a partial path', async (status) => {
    apiClient.defaults.adapter = async config => { throw new AxiosError('missing', undefined, config, undefined, { config, status, statusText: 'Unavailable', headers: new AxiosHeaders(), data: { message: 'Folder unavailable' } }) }
    await expect(resolveSearchPath(7, new Map(), new AbortController().signal)).rejects.toMatchObject({ status })
  })
})
