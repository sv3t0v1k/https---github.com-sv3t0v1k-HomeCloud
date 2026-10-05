import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import { UploadQueue } from './uploadQueue'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
const request = vi.mocked(apiRequest)
const queues: UploadQueue[] = []

interface TestSession {
  uploadId: string; filename: string; totalSize: number; chunkSize: number; totalChunks: number
  uploadedSize: number; parentId?: number; status: string; expiresAt: string
  chunks: { chunkIndex: number; byteSize: number; sha256: string }[]
}

function fixture() {
  const sessions = new Map<string, TestSession>()
  const calls: AxiosRequestConfig[] = []
  let onChunk: ((session: TestSession, index: number) => Promise<void>) | undefined
  let onDelete: (() => Promise<void>) | undefined
  let onCreate: (() => Promise<void>) | undefined
  let onComplete: (() => Promise<void>) | undefined
  let onDiscovery: (() => Promise<void>) | undefined
  let sequence = 0
  async function handler(config: AxiosRequestConfig): Promise<unknown> {
    calls.push(config)
    if (config.url === '/uploads/limits') return { effectiveMaxFileBytes: 1000, maxChunkBytes: 3, maxChunks: 1000 }
    if (config.url === '/uploads/sessions') { const captured: unknown = JSON.parse(JSON.stringify([...sessions.values()])); await onDiscovery?.(); return captured }
    if (config.url === '/uploads/session') {
      const data = config.data as { filename: string; totalSize: number; chunkSize: number; parentId?: number }
      const session: TestSession = { uploadId: `u${++sequence}`, ...data, totalChunks: Math.ceil(data.totalSize / data.chunkSize),
        uploadedSize: 0, status: 'pending', expiresAt: '2030-01-01T00:00:00Z', chunks: [] }
      sessions.set(session.uploadId, session)
      await onCreate?.()
      return { ...session, chunks: [] }
    }
    const match = config.url?.match(/^\/uploads\/session\/([^/]+)(\/chunk|\/complete)?$/)
    if (!match) throw new Error(`Unexpected request: ${config.url}`)
    const session = sessions.get(match[1])!
    if (config.method === 'DELETE') { await onDelete?.(); sessions.delete(match[1]); return {} }
    if (!match[2]) return { ...session, chunks: [...session.chunks], ...(session.status === 'completed' ? { file: { id: 7, name: session.filename, size: session.totalSize, mimeType: 'application/octet-stream', isDeleted: false, isStarred: false, parentId: session.parentId ?? null, updatedAt: '2026-01-01T00:00:00Z' } } : {}) }
    if (match[2] === '/complete') {
      session.status = 'completed'
      await onComplete?.()
      return { id: 7, name: session.filename, size: session.totalSize, mimeType: 'application/octet-stream',
        isDeleted: false, isStarred: false, parentId: session.parentId ?? null, updatedAt: '2026-01-01T00:00:00Z' }
    }
    const form = config.data as FormData
    const index = Number(form.get('chunkIndex'))
    await onChunk?.(session, index)
    const blob = form.get('chunk') as Blob
    const bytes = await read(blob)
    const sha256 = await hash(bytes)
    if (!session.chunks.some((chunk) => chunk.chunkIndex === index)) {
      session.chunks.push({ chunkIndex: index, byteSize: blob.size, sha256 })
      session.uploadedSize += blob.size
    }
    session.status = 'uploading'
    return {}
  }
  request.mockImplementation(<T>(config: AxiosRequestConfig) => handler(config) as Promise<T>)
  return { sessions, calls,
    set onChunk(value: typeof onChunk) { onChunk = value },
    set onDelete(value: typeof onDelete) { onDelete = value },
    set onCreate(value: typeof onCreate) { onCreate = value },
    set onComplete(value: typeof onComplete) { onComplete = value },
    set onDiscovery(value: typeof onDiscovery) { onDiscovery = value },
    chunkIndexes: () => calls.filter((call) => call.url?.endsWith('/chunk')).map((call) => Number((call.data as FormData).get('chunkIndex'))),
    creates: () => calls.filter((call) => call.url === '/uploads/session').length }
}
function queue(storage: Storage | null = null) { const result = new UploadQueue(42, storage); queues.push(result); return result }
function file(name = 'artifact.bin', size = 10) { return new File([Uint8Array.from({ length: size }, (_, index) => index)], name, { type: 'application/octet-stream', lastModified: 1234 }) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function read(blob: Blob) { return new Promise<ArrayBuffer>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob) }) }
// Deterministic digest double: these tests verify identity/reconciliation decisions, not WebCrypto itself.
function fixtureDigest(bytes: Uint8Array) { const result = new Uint8Array(32); bytes.forEach((byte, index) => { result[index % 32] = (result[index % 32] * 17 + byte + index) % 256 }); return result.buffer }
async function hash(bytes: ArrayBuffer) { return [...new Uint8Array(fixtureDigest(new Uint8Array(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
function state(q: UploadQueue, id: string) { return q.getSnapshot().find((item) => item.id === id)! }

beforeEach(() => { vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, data: Uint8Array | ArrayBuffer) => fixtureDigest(data instanceof Uint8Array ? data : new Uint8Array(data)) } }); request.mockReset(); window.localStorage.clear() })
afterEach(() => { for (const q of queues.splice(0)) q.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('UploadQueue', () => {
  it('bounds requests to two files and one chunk per file; failures and targets are isolated', async () => {
    const server = fixture()
    const gate = deferred()
    let active = 0
    let maximum = 0
    server.onChunk = async (session) => {
      active++; maximum = Math.max(maximum, active)
      await gate.promise
      active--
      if (session.filename === 'bad.bin') throw new ApiError('raw internal error', 'validation', 400)
    }
    const q = queue()
    const ids = q.enqueue(['good.bin', 'bad.bin', 'unknown.weird', 'noextension', 'photo.jpg'].map((name) => file(name)), 19)
    await vi.waitFor(() => expect(active).toBe(2))
    expect(server.creates()).toBe(2)
    gate.resolve()
    await vi.waitFor(() => expect(q.getSnapshot().filter((item) => item.state === 'completed')).toHaveLength(4))
    expect(maximum).toBe(2)
    expect(state(q, ids[1])).toMatchObject({ state: 'error', committedBytes: 0 })
    expect(state(q, ids[1]).error).not.toContain('raw internal error')
    expect(q.getSnapshot().every((item) => item.parentId === 19)).toBe(true)
    expect(server.calls.filter((call) => call.url === '/uploads/session').every((call) => call.data.parentId === 19)).toBe(true)
  })

  it('supports manual selection/start; rejects empty files without affecting siblings', async () => {
    const server = fixture()
    const q = queue()
    const [first, empty] = q.enqueue([file(), file('empty.bin', 0)], undefined, false)
    expect(state(q, first).state).toBe('selected')
    expect(state(q, empty).state).toBe('error')
    expect(server.creates()).toBe(0)
    q.startAll()
    await vi.waitFor(() => expect(state(q, first).state).toBe('completed'))
    expect(server.creates()).toBe(1)
  })

  it('settles an in-flight chunk before paused; committed progress resumes the same session', async () => {
    const server = fixture()
    const gate = deferred()
    server.onChunk = async (_, index) => { if (index === 1) await gate.promise }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(server.chunkIndexes()).toEqual([0, 1]))
    expect(state(q, id).committedBytes).toBe(3)
    q.pause(id)
    expect(state(q, id).state).toBe('pausing')
    expect(state(q, id).committedBytes).toBe(3)
    gate.resolve()
    await vi.waitFor(() => expect(state(q, id).state).toBe('paused'))
    expect(state(q, id)).toMatchObject({ committedBytes: 6, percent: 60 })
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.chunkIndexes()).toEqual([0, 1])
    q.resume(id)
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    expect(server.creates()).toBe(1)
    expect(server.chunkIndexes()).toEqual([0, 1, 2, 3])
    expect(state(q, id)).toMatchObject({ percent: 100, committedBytes: 10 })
  })

  it('paused jobs release slots so queued siblings finish', async () => {
    const server = fixture()
    const gate = deferred()
    server.onChunk = async (session, index) => { if (session.filename !== 'third.bin' && index === 0) await gate.promise }
    const q = queue()
    const ids = q.enqueue([file('first.bin'), file('second.bin'), file('third.bin')])
    await vi.waitFor(() => expect(server.chunkIndexes()).toHaveLength(2))
    q.pause(ids[0]); q.pause(ids[1]); gate.resolve()
    await vi.waitFor(() => expect(state(q, ids[2]).state).toBe('completed'))
    expect(state(q, ids[0]).state).toBe('paused')
    expect(state(q, ids[1]).state).toBe('paused')
  })

  it('exhausted network retries preserve reservation; explicit Resume reconciles accepted chunks', async () => {
    const server = fixture()
    let offline = true
    server.onChunk = async (_, index) => { if (index === 1 && offline) throw new ApiError('offline', 'network') }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(state(q, id).state).toBe('error'), { timeout: 2000 })
    expect(state(q, id).committedBytes).toBe(3)
    expect(server.sessions.size).toBe(1)
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false)
    offline = false
    q.resume(id)
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'), { timeout: 2000 })
    expect(server.creates()).toBe(1)
    expect(server.chunkIndexes().filter((index) => index === 0)).toHaveLength(1)
  })

  it('reload metadata contains no file bytes or token; reselection verifies identity and committed hashes', async () => {
    const server = fixture()
    const gate = deferred()
    server.onChunk = async (_, index) => { if (index === 1) await gate.promise }
    const original = queue(window.localStorage)
    const [id] = original.enqueue([file()], 5)
    await vi.waitFor(() => expect(server.chunkIndexes()).toEqual([0, 1]))
    original.pause(id); gate.resolve()
    await vi.waitFor(() => expect(state(original, id).state).toBe('paused'))
    original.dispose()
    const saved = window.localStorage.getItem('homecloud.uploads.v1.owner.42')!
    expect(saved).toContain('fingerprint')
    expect(saved).not.toMatch(/token|password|Authorization|fileBytes/)
    const restored = queue(window.localStorage)
    expect(state(restored, id)).toMatchObject({ state: 'needs-file', committedBytes: 6, needsFile: true })
    await expect(restored.reselect(id, file('wrong.bin'))).rejects.toThrow('исходный')
    const wrong = new File([new Uint8Array(10).fill(9)], 'artifact.bin')
    await expect(restored.reselect(id, wrong)).rejects.toThrow('отличается')
    await restored.reselect(id, file())
    await vi.waitFor(() => expect(state(restored, id).state).toBe('completed'))
    expect(server.creates()).toBe(1)
    expect(server.chunkIndexes()).toEqual([0, 1, 2, 3])
    expect(window.localStorage.getItem('homecloud.uploads.v1.owner.42')).toBeNull()
  })

  it('discovered sessions validate EVERY committed hash even without a saved fingerprint', async () => {
    const server = fixture()
    const expectedHash = await hash(Uint8Array.from([7, 8, 9]).buffer)
    server.sessions.set('existing', { uploadId: 'existing', filename: 'artifact.bin', totalSize: 10, chunkSize: 3,
      totalChunks: 4, uploadedSize: 3, parentId: 8, status: 'uploading', expiresAt: '2030-01-01T00:00:00Z',
      chunks: [{ chunkIndex: 0, byteSize: 3, sha256: expectedHash }] })
    const q = queue()
    await q.discover()
    const id = q.getSnapshot()[0].id
    await q.reselect(id, file())
    await vi.waitFor(() => expect(state(q, id).state).toBe('needs-file'))
    expect(state(q, id).error).toContain('не совпадают')
    expect(server.chunkIndexes()).toHaveLength(0)
    expect(server.creates()).toBe(0)
  })

  it('cancel isolates siblings and confirms DELETE; failed cancellation remains retryable after reload', async () => {
    const server = fixture()
    const gate = deferred()
    server.onChunk = async (session) => { if (session.filename === 'cancel.bin') await gate.promise }
    let failDelete = true
    server.onDelete = async () => { if (failDelete) throw new ApiError('no permission', 'authorization', 403) }
    const q = queue(window.localStorage)
    const [cancelId, siblingId] = q.enqueue([file('cancel.bin'), file('sibling.bin')])
    await vi.waitFor(() => expect(server.chunkIndexes().length).toBeGreaterThan(0))
    q.cancel(cancelId)
    gate.resolve()
    await vi.waitFor(() => expect(state(q, siblingId).state).toBe('completed'))
    await vi.waitFor(() => expect(state(q, cancelId).state).toBe('error'))
    expect(state(q, cancelId).error).toContain('Не удалось подтвердить отмену')
    expect(state(q, cancelId).committedBytes).toBeGreaterThan(0)
    expect(server.sessions.has(state(q, cancelId).uploadId!)).toBe(true)
    q.dispose()
    const restored = queue(window.localStorage)
    expect(state(restored, cancelId).error).toContain('Отмена не подтверждена')
    failDelete = false
    restored.cancel(cancelId)
    await vi.waitFor(() => expect(state(restored, cancelId).state).toBe('cancelled'))
    expect(state(restored, cancelId)).toMatchObject({ committedBytes: 0, percent: 0 })
    expect(server.sessions.has(state(q, cancelId).uploadId!)).toBe(false)
  })

  it('pause interrupts Retry-After wait; Resume retains server notBefore and committed progress', async () => {
    vi.useFakeTimers()
    // Disable sampling only here to make timers independent of FileReader tasks.
    vi.stubGlobal('crypto', undefined)
    const server = fixture()
    let limited = true
    server.onChunk = async () => { if (limited) throw new ApiError('limit', 'rate-limit', 429, '2') }
    const q = queue()
    const [id] = q.enqueue([file('rate.bin', 3)])
    await vi.advanceTimersByTimeAsync(0)
    expect(state(q, id).state).toBe('retrying')
    q.pause(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(state(q, id).state).toBe('paused')
    expect(vi.getTimerCount()).toBe(0)
    limited = false
    // No committed chunks: reconciliation needs no digest, and sampling remains optional.
    q.resume(id)
    await vi.advanceTimersByTimeAsync(1999)
    expect(server.chunkIndexes()).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    expect(server.chunkIndexes()).toEqual([0, 0])
    expect(server.creates()).toBe(1)
  })

  it('lost creation response discovers server session and prevents duplicate creation on Resume', async () => {
    const server = fixture()
    server.onCreate = async () => { throw new ApiError('lost response', 'network') }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(q.getSnapshot()).toHaveLength(2))
    expect(state(q, id).state).toBe('error')
    q.resume(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.creates()).toBe(1)
    expect(q.getSnapshot().filter((item) => item.needsFile)).toHaveLength(1)
  })

  it('lost completion response never claims success early; Resume discovers finalized file without recreating it', async () => {
    const server = fixture()
    server.onComplete = async () => { throw new ApiError('lost ACK', 'network') }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(state(q, id).state).toBe('error'))
    expect(state(q, id)).toMatchObject({ committedBytes: 10, percent: 99 })
    q.resume(id)
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    expect(state(q, id)).toMatchObject({ percent: 100, completedFile: { id: 7 } })
    expect(server.creates()).toBe(1)
    expect(server.calls.filter((call) => call.url?.endsWith('/complete'))).toHaveLength(1)
  })

  it('stuck DELETE is bounded and remains unconfirmed instead of falsely cancelled', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', undefined)
    const server = fixture()
    const gate = deferred()
    server.onChunk = async () => gate.promise
    server.onDelete = async () => new Promise<void>(() => {})
    const q = queue()
    const [id] = q.enqueue([file('stuck.bin', 3)])
    await vi.advanceTimersByTimeAsync(0)
    q.cancel(id)
    gate.resolve()
    await vi.runAllTimersAsync()
    expect(state(q, id).state).toBe('error')
    expect(state(q, id).error).toContain('Не удалось подтвердить отмену')
    expect(server.sessions.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('Pause before an in-flight 429 response still retains Retry-After when resumed', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', undefined)
    const server = fixture()
    const gate = deferred()
    let first = true
    server.onChunk = async () => {
      if (first) { first = false; await gate.promise; throw new ApiError('limit', 'rate-limit', 429, '2') }
    }
    const q = queue()
    const [id] = q.enqueue([file('late-limit.bin', 3)])
    await vi.advanceTimersByTimeAsync(0)
    expect(server.chunkIndexes()).toEqual([0])
    q.pause(id)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(state(q, id)).toMatchObject({ state: 'paused', committedBytes: 0 })
    q.resume(id)
    await vi.advanceTimersByTimeAsync(1999)
    expect(server.chunkIndexes()).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    expect(server.chunkIndexes()).toEqual([0, 0])
  })

  it('Cancel after a lost completion ACK reconciles the stored file instead of retaining impossible cancellation', async () => {
    const server = fixture()
    server.onComplete = async () => { throw new ApiError('lost completion', 'network') }
    server.onDelete = async () => { throw new ApiError('already completed', 'validation', 400) }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(state(q, id).state).toBe('error'))
    q.cancel(id)
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    expect(state(q, id)).toMatchObject({ committedBytes: 10, percent: 100, completedFile: { id: 7 } })
    expect(server.sessions.get(state(q, id).uploadId!)?.status).toBe('completed')
  })

  it('stale discovery cannot overwrite committed bytes or metadata after completion', async () => {
    const server = fixture()
    const chunkGate = deferred()
    const discoveryGate = deferred()
    server.onChunk = async (_, index) => { if (index === 1) await chunkGate.promise }
    const q = queue()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(server.chunkIndexes()).toEqual([0, 1]))
    server.onDiscovery = async () => discoveryGate.promise
    const discovery = q.discover()
    chunkGate.resolve()
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
    discoveryGate.resolve()
    await discovery
    expect(state(q, id)).toMatchObject({ committedBytes: 10, percent: 100, state: 'completed' })
  })

  it('restores and retains more than 200 locally known sessions without HTTP or file reads', () => {
    const saved = Array.from({ length: 205 }, (_, index) => ({
      id: `saved-${index}`, name: `artifact-${index}.bin`, size: 10,
      uploadId: `session-${index}`, committedBytes: index % 10, parentId: 5,
    }))
    window.localStorage.setItem('homecloud.uploads.v1.owner.42', JSON.stringify(saved))
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const q = queue(window.localStorage)
    expect(q.getSnapshot()).toHaveLength(205)
    expect(q.getSnapshot().every((item) => item.state === 'needs-file')).toBe(true)
    expect(q.getSnapshot().map((item) => item.id)).toEqual(saved.map((item) => item.id))
    expect(request).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(window.localStorage.getItem('homecloud.uploads.v1.owner.42')!) as unknown[]
    expect(persisted).toHaveLength(205)
    write.mockRestore()
  })

  it('StrictMode authenticated discovery can remount a disposed queue without losing controls', async () => {
    fixture()
    const q = queue()
    q.dispose()
    await q.discover()
    const [id] = q.enqueue([file()])
    await vi.waitFor(() => expect(state(q, id).state).toBe('completed'))
  })
})
