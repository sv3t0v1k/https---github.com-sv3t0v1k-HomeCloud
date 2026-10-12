// @vitest-environment node
import { AxiosError, AxiosHeaders, type AxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { ApiError, normalizeApiError } from '../api/errors'
import type { FileItem } from '../types/files'
import { UploadQueue, type UploadQueueItem } from './uploadQueue'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
const nodeCryptoModule = 'node:crypto'
const { createHash, webcrypto } = await import(nodeCryptoModule) as {
  createHash: (algorithm: string) => { update: (bytes: Uint8Array) => { digest: (format: 'hex') => string } }
  webcrypto: Crypto
}
const request = vi.mocked(apiRequest)
const queues: UploadQueue[] = []
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const makeFile = (bytes: Uint8Array, name = 'fixture.bin') => new File([bytes], name, { lastModified: 1234 })
const bytesFor = (size = 1024 * 1024) => Uint8Array.from({ length: size }, (_, index) => (index * 31 + (index >>> 8)) & 255)

function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }, clear: () => values.clear() }
}
function queue(saved: Storage | null = null) { const q = new UploadQueue(42, saved); queues.push(q); return q }
function item(q: UploadQueue, id: string) { return q.getSnapshot().find((entry) => entry.id === id)! }
function snapshots(q: UploadQueue) {
  const result: UploadQueueItem[] = []
  q.subscribe(() => result.push(...q.getSnapshot().map((entry) => ({ ...entry }))))
  return result
}

function rejected503(message: string, retryAfter?: string) {
  const headers = new AxiosHeaders(retryAfter === undefined ? {} : { 'Retry-After': retryAfter })
  return normalizeApiError(new AxiosError(message, 'ERR_BAD_RESPONSE', undefined, undefined,
    { status: 503, statusText: 'Service Unavailable', headers, data: { message }, config: { headers: new AxiosHeaders() } }))
}

function server(ssd = true) {
  interface Session {
    uploadId: string; filename: string; totalSize: number; chunkSize: number; totalChunks: number
    uploadedSize: number; status: string; expiresAt: string; parentId?: number; expectedSha256?: string
    chunks: { chunkIndex: number; byteSize: number; sha256: string }[]; parts: Map<number, Uint8Array>; file?: FileItem
  }
  const calls: (AxiosRequestConfig & { calledAt: number })[] = []
  const sessions = new Map<string, Session>()
  let admissionFailures = 0
  let admissionFailure: ApiError | undefined
  let loseCompleteResponse = false
  let reservedBytes = 0
  let usedBytes = 0
  let publications = 0
  let beforeChunk: (() => Promise<void>) | undefined
  let beforeCleanup: (() => Promise<void>) | undefined
  let cleanupFailures = 0
  // Manual API model of the backend's global SSD cleanup barrier. A publication
  // receipt does not clear this set; only successful idempotent complete does.
  // This is a regression fixture, not browser/Docker cleanup qualification.
  const pendingCleanup = new Set<string>()
  const receipt = (session: Session) => {
    return { uploadId: session.uploadId, filename: session.filename, totalSize: session.totalSize,
      chunkSize: session.chunkSize, totalChunks: session.totalChunks, uploadedSize: session.uploadedSize,
      status: session.status, expiresAt: session.expiresAt, parentId: session.parentId,
      expectedSha256: session.expectedSha256, file: session.file, chunks: [...session.chunks] }
  }
  async function handle(config: AxiosRequestConfig): Promise<unknown> {
    calls.push({ ...config, calledAt: Date.now() })
    if (config.url === '/uploads/limits') return { storageMode: ssd ? 'ssd' : 'legacy', wholeSha256Required: ssd,
      effectiveMaxFileBytes: 100 * 1024 ** 2, maxChunkBytes: 10 * 1024 ** 2, maxChunks: 1000 }
    if (config.url === '/uploads/sessions') return [...sessions.values()].map(receipt)
    if (config.url === '/uploads/session') {
      if (admissionFailures > 0) { admissionFailures--; throw admissionFailure! }
      const data = config.data as { filename: string; totalSize: number; chunkSize: number; parentId?: number; expectedSha256?: string }
      if (ssd && !/^[a-f0-9]{64}$/.test(data.expectedSha256 ?? '')) throw new ApiError('Expected lowercase SHA-256', 'validation', 400)
      const session: Session = { ...data, uploadId: `session-${sessions.size + 1}`, totalChunks: Math.ceil(data.totalSize / data.chunkSize),
        uploadedSize: 0, status: 'pending', expiresAt: '2030-01-01T00:00:00Z', chunks: [], parts: new Map() }
      sessions.set(session.uploadId, session)
      reservedBytes += data.totalSize
      return receipt(session)
    }
    const match = config.url?.match(/^\/uploads\/session\/([^/]+)(\/chunk|\/complete)?$/)
    if (!match) throw new Error(`Unexpected request ${config.method} ${config.url}`)
    const session = sessions.get(match[1])!
    if (config.method === 'DELETE') { reservedBytes -= session.totalSize; session.status = 'aborted'; return {} }
    if (!match[2]) return receipt(session)
    if (match[2] === '/chunk') {
      await beforeChunk?.()
      const form = config.data as FormData
      const index = Number(form.get('chunkIndex'))
      const blob = form.get('chunk') as Blob
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!session.parts.has(index)) {
        session.parts.set(index, bytes)
        session.chunks.push({ chunkIndex: index, byteSize: bytes.length, sha256: sha256(bytes) })
        session.uploadedSize += bytes.length
      }
      session.status = 'uploading'
      return {}
    }
    if (session.status !== 'completed') {
      // Actual backend behavior: a prior global cleanup barrier permits
      // admission/chunks but prevents a new finalization from beginning (500).
      // A completed session's idempotent replay can still clear its barrier.
      if (ssd && pendingCleanup.size > 0) throw new ApiError('SSD cleanup barrier prevents new finalization', 'server', 500)
      const whole = new Uint8Array(session.totalSize)
      for (const [index, part] of session.parts) whole.set(part, index * session.chunkSize)
      if (ssd && sha256(whole) !== session.expectedSha256) throw new ApiError('Whole digest mismatch', 'validation', 400)
      session.status = 'completed'
      session.file = { id: 71, name: session.filename, size: session.totalSize, mimeType: 'application/octet-stream',
        isDeleted: false, isStarred: false, parentId: session.parentId ?? null, updatedAt: '2026-10-13T00:00:00Z' }
      reservedBytes -= session.totalSize
      usedBytes += session.totalSize
      publications++
      if (ssd) pendingCleanup.add(session.uploadId)
    }
    if (loseCompleteResponse) { loseCompleteResponse = false; throw new ApiError('Response lost after publication', 'network') }
    await beforeCleanup?.()
    if (cleanupFailures > 0) { cleanupFailures--; throw rejected503('Upload buffer cleanup is busy') }
    pendingCleanup.delete(session.uploadId)
    return session.file
  }
  request.mockImplementation(<T>(config: AxiosRequestConfig) => handle(config) as Promise<T>)
  return { calls, sessions, get reservedBytes() { return reservedBytes }, get usedBytes() { return usedBytes }, get publications() { return publications },
    get pendingCleanupCount() { return pendingCleanup.size },
    admissionCalls: () => calls.filter((call) => call.url === '/uploads/session'),
    chunkCalls: () => calls.filter((call) => call.url?.endsWith('/chunk')),
    failAdmissions: (count: number, error: ApiError) => { admissionFailures = count; admissionFailure = error },
    failCleanup: (count: number) => { cleanupFailures = count },
    seedPublished: (bytes: Uint8Array, name = 'fixture.bin') => {
      const uploadId = `session-${sessions.size + 1}`
      const file: FileItem = { id: 71, name, size: bytes.length, mimeType: 'application/octet-stream',
        isDeleted: false, isStarred: false, parentId: null, updatedAt: '2026-10-13T00:00:00Z' }
      sessions.set(uploadId, { uploadId, filename: name, totalSize: bytes.length, chunkSize: 10 * 1024 ** 2, totalChunks: 1,
        uploadedSize: bytes.length, status: 'completed', expiresAt: '2030-01-01T00:00:00Z', expectedSha256: sha256(bytes),
        chunks: [{ chunkIndex: 0, byteSize: bytes.length, sha256: sha256(bytes) }], parts: new Map([[0, bytes]]), file })
      usedBytes += bytes.length
      publications++
      pendingCleanup.add(uploadId)
      return uploadId
    },
    loseCompletionResponse: () => { loseCompleteResponse = true },
    set beforeChunk(value: typeof beforeChunk) { beforeChunk = value },
    set beforeCleanup(value: typeof beforeCleanup) { beforeCleanup = value } }
}

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
})
afterEach(() => {
  for (const q of queues.splice(0)) q.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SSD upload queue regression gates', () => {
  it('hashes actual whole bytes before SSD admission and reports hashing separately from committed progress', async () => {
    const backend = server()
    const q = queue()
    const history = snapshots(q)
    const bytes = bytesFor()
    const [id] = q.enqueue([makeFile(bytes)], 19)
    await vi.waitFor(() => expect(item(q, id).state).toBe('completed'))
    expect(backend.admissionCalls()).toHaveLength(1)
    expect(backend.admissionCalls()[0].data).toEqual({ filename: 'fixture.bin', totalSize: bytes.length,
      chunkSize: 10 * 1024 ** 2, parentId: 19, expectedSha256: sha256(bytes) })
    const hashing = history.filter((entry) => entry.state === 'hashing')
    expect(hashing.some((entry) => (entry.hashedBytes ?? 0) > 0 && (entry.hashedBytes ?? 0) < bytes.length)).toBe(true)
    expect(hashing[hashing.length - 1]).toMatchObject({ hashedBytes: bytes.length, hashPercent: 100, committedBytes: 0, percent: 0 })
    expect(history.findIndex((entry) => entry.state === 'hashing')).toBeLessThan(history.findIndex((entry) => entry.state === 'uploading'))
    expect(history.some((entry) => entry.state === 'completing' && entry.percent === 99)).toBe(true)
    expect(item(q, id)).toMatchObject({ state: 'completed', percent: 100, completedFile: { id: 71 } })
  })

  it('keeps SSD OFF admission compatible with legacy and never enters whole-hashing state', async () => {
    const backend = server(false)
    const q = queue()
    const history = snapshots(q)
    const bytes = bytesFor()
    const [id] = q.enqueue([makeFile(bytes)])
    await vi.waitFor(() => expect(item(q, id).state).toBe('completed'))
    expect(backend.admissionCalls()[0].data).toEqual({ filename: 'fixture.bin', totalSize: bytes.length, chunkSize: 10 * 1024 ** 2 })
    expect(history.some((entry) => entry.state === 'hashing')).toBe(false)
    expect(history.every((entry) => entry.hashedBytes === undefined)).toBe(true)
  })

  it.each(['pause', 'cancel'] as const)('%s during actual whole hashing makes zero admission requests', async (operation) => {
    const backend = server()
    const q = queue()
    let stopped = false
    q.subscribe(() => {
      const current = q.getSnapshot()[0]
      if (!stopped && current?.state === 'hashing' && (current.hashedBytes ?? 0) > 0) {
        stopped = true
        if (operation === 'pause') q.pause(current.id)
        else q.cancel(current.id)
      }
    })
    const [id] = q.enqueue([makeFile(bytesFor(3 * 1024 ** 2))])
    await vi.waitFor(() => expect(item(q, id).state).toBe(operation === 'pause' ? 'paused' : 'cancelled'))
    expect(stopped).toBe(true)
    expect(backend.admissionCalls()).toHaveLength(0)
    expect(backend.chunkCalls()).toHaveLength(0)
    expect(backend.reservedBytes).toBe(0)
  })

  it('retries definite busy503 admission with Retry-After, then admits exactly one server session', async () => {
    const backend = server()
    backend.failAdmissions(2, rejected503('Upload buffer is busy', '1'))
    const q = queue()
    const [id] = q.enqueue([makeFile(bytesFor(100))])
    await vi.waitFor(() => expect(item(q, id).state).toBe('completed'), { timeout: 4000 })
    const admissions = backend.admissionCalls()
    expect(admissions).toHaveLength(3)
    expect(admissions[1].calledAt - admissions[0].calledAt).toBeGreaterThanOrEqual(1000)
    expect(admissions[2].calledAt - admissions[1].calledAt).toBeGreaterThanOrEqual(1000)
    expect(admissions.every((call) => call.data.expectedSha256 === sha256(bytesFor(100)))).toBe(true)
    expect(backend.sessions.size).toBe(1)
    expect(backend.publications).toBe(1)
  })

  it('stops persistent busy503 admission after three attempts without creating a session', async () => {
    const backend = server()
    backend.failAdmissions(20, rejected503('Upload buffer is busy'))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const q = queue()
    const [id] = q.enqueue([makeFile(bytesFor(100))])
    await vi.waitFor(() => expect(item(q, id).state).toBe('error'), { timeout: 2500 })
    expect(backend.admissionCalls()).toHaveLength(3)
    expect(item(q, id).error).toContain('занято')
    expect(item(q, id).error).not.toContain('Недостаточно')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(backend.admissionCalls()).toHaveLength(3)
    expect(backend.sessions.size).toBe(0)
    expect(backend.reservedBytes).toBe(0)
  })

  it('pauses known busy503 admission backoff and resumes after Retry-After without ambiguous creation or duplicate reservation', async () => {
    const backend = server()
    backend.failAdmissions(1, rejected503('Upload buffer is busy', '1'))
    const q = queue()
    let pausedOnce = false
    q.subscribe(() => {
      const current = q.getSnapshot()[0]
      if (!pausedOnce && current?.state === 'retrying') {
        pausedOnce = true
        q.pause(current.id)
      }
    })
    const bytes = bytesFor(100)
    const [id] = q.enqueue([makeFile(bytes)])
    await vi.waitFor(() => expect(item(q, id).state).toBe('paused'))
    expect(backend.admissionCalls()).toHaveLength(1)
    expect(backend.sessions.size).toBe(0)
    expect(backend.reservedBytes).toBe(0)
    q.resume(id)
    await vi.waitFor(() => expect(item(q, id).state).toBe('completed'), { timeout: 2500 })
    const admissions = backend.admissionCalls()
    expect(admissions).toHaveLength(2)
    expect(admissions[1].calledAt - admissions[0].calledAt).toBeGreaterThanOrEqual(1000)
    expect(backend.calls.some((call) => call.url === '/uploads/sessions')).toBe(false)
    expect(backend.sessions.size).toBe(1)
    expect(backend.publications).toBe(1)
    expect(backend.usedBytes).toBe(bytes.length)
    expect(backend.reservedBytes).toBe(0)
  })

  it.each(['SSD', 'HDD'])('does not retry capacity503 for %s and shows capacity rather than busy', async (tier) => {
    const backend = server()
    backend.failAdmissions(20, rejected503(`Insufficient ${tier} capacity`, '1'))
    const q = queue()
    const [id] = q.enqueue([makeFile(bytesFor(100))])
    await vi.waitFor(() => expect(item(q, id).state).toBe('error'))
    expect(backend.admissionCalls()).toHaveLength(1)
    expect(item(q, id).error).toContain('Недостаточно свободного места')
    expect(item(q, id).error).not.toContain('занято')
    expect(backend.sessions.size).toBe(0)
  })

  it('reconciles completed after response loss with bounded complete replay but without duplicate quota charge or UI completion', async () => {
    const backend = server()
    backend.loseCompletionResponse()
    const q = queue()
    const history = snapshots(q)
    const bytes = bytesFor(100)
    const [id] = q.enqueue([makeFile(bytes)])
    await vi.waitFor(() => expect(item(q, id).state).toBe('completed'))
    expect(backend.calls.filter((call) => call.method === 'POST' && call.url?.endsWith('/complete'))).toHaveLength(2)
    expect(backend.calls.filter((call) => call.method === 'GET' && call.url === '/uploads/session/session-1')).toHaveLength(1)
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(backend.publications).toBe(1)
    expect(backend.usedBytes).toBe(bytes.length)
    expect(backend.reservedBytes).toBe(0)
    const completionTransitions = history.filter((entry, index) => entry.state === 'completed' && history[index - 1]?.state !== 'completed')
    expect(completionTransitions).toHaveLength(1)
    q.resume(id)
    expect(backend.admissionCalls()).toHaveLength(1)
    expect(backend.pendingCleanupCount).toBe(0)
    // Ordinary next-file finalization would fail500 if GET had been mistaken
    // for cleanup confirmation. The successful replay must release the barrier.
    const [nextId] = q.enqueue([makeFile(bytes, 'next.bin')])
    await vi.waitFor(() => expect(item(q, nextId).state).toBe('completed'))
    expect(backend.admissionCalls()).toHaveLength(2)
    expect(backend.publications).toBe(2)
    expect(backend.usedBytes).toBe(bytes.length * 2)
    expect(backend.reservedBytes).toBe(0)
    expect(backend.pendingCleanupCount).toBe(0)
  })

  it('drives pending cleanup for a restored completed receipt before reporting UI100', async () => {
    const backend = server()
    const bytes = bytesFor(100)
    const uploadId = backend.seedPublished(bytes)
    const saved = storage()
    saved.setItem('homecloud.uploads.v1.owner.42', JSON.stringify([
      { id: 'restored', uploadId, name: 'fixture.bin', size: bytes.length, committedBytes: bytes.length, expectedSha256: sha256(bytes) },
    ]))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    backend.beforeCleanup = () => gate
    const q = queue(saved)
    const history = snapshots(q)
    await q.reselect('restored', makeFile(bytes))
    await vi.waitFor(() => expect(backend.calls.filter((call) => call.url?.endsWith('/complete'))).toHaveLength(1))
    expect(backend.pendingCleanupCount).toBe(1)
    expect(history.some((entry) => entry.state === 'completed' || entry.percent === 100)).toBe(false)
    expect(item(q, 'restored').percent).toBe(99)
    release()
    await vi.waitFor(() => expect(item(q, 'restored').state).toBe('completed'))
    expect(item(q, 'restored').percent).toBe(100)
    expect(backend.pendingCleanupCount).toBe(0)
    expect(backend.publications).toBe(1)
    expect(backend.usedBytes).toBe(bytes.length)
    expect(backend.admissionCalls()).toHaveLength(0)
    expect(backend.chunkCalls()).toHaveLength(0)
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('stops three failed cleanup replays at actionable99 for an already published restored file', async () => {
    const backend = server()
    const bytes = bytesFor(100)
    const uploadId = backend.seedPublished(bytes)
    backend.failCleanup(3)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const saved = storage()
    saved.setItem('homecloud.uploads.v1.owner.42', JSON.stringify([
      { id: 'restored', uploadId, name: 'fixture.bin', size: bytes.length, committedBytes: bytes.length, expectedSha256: sha256(bytes) },
    ]))
    const q = queue(saved)
    const history = snapshots(q)
    await q.reselect('restored', makeFile(bytes))
    await vi.waitFor(() => expect(item(q, 'restored').state).toBe('error'), { timeout: 2500 })
    expect(item(q, 'restored')).toMatchObject({ percent: 99, committedBytes: bytes.length })
    expect(item(q, 'restored').error).toContain('Продолжить')
    expect(history.some((entry) => entry.state === 'completed' || entry.percent === 100)).toBe(false)
    expect(backend.calls.filter((call) => call.method === 'POST' && call.url?.endsWith('/complete'))).toHaveLength(3)
    expect(backend.pendingCleanupCount).toBe(1)
    expect(backend.publications).toBe(1)
    expect(backend.usedBytes).toBe(bytes.length)
    expect(backend.reservedBytes).toBe(0)
    expect(saved.getItem('homecloud.uploads.v1.owner.42')).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(backend.calls.filter((call) => call.url?.endsWith('/complete'))).toHaveLength(3)
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false)
    // Only the explicit user action opens another bounded retry window.
    q.resume('restored')
    await vi.waitFor(() => expect(item(q, 'restored').state).toBe('completed'), { timeout: 2500 })
    expect(backend.pendingCleanupCount).toBe(0)
    expect(backend.publications).toBe(1)
    expect(backend.usedBytes).toBe(bytes.length)
  })

  it('rejects reselected file after reload when sampled identity matches but unsent whole bytes changed', async () => {
    const backend = server()
    const saved = storage()
    const original = bytesFor()
    const q = queue(saved)
    let releaseChunk: () => void = () => {}
    const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve })
    backend.beforeChunk = () => chunkGate
    const [id] = q.enqueue([makeFile(original)])
    await vi.waitFor(() => expect(backend.chunkCalls()).toHaveLength(1))
    q.pause(id)
    // The existing queue settles its in-flight request; metadata is copied at
    // the pre-commit point, modeling a browser reload before that response.
    const copied = storage()
    const persisted = saved.getItem('homecloud.uploads.v1.owner.42')!
    copied.setItem('homecloud.uploads.v1.owner.42', persisted)
    expect(JSON.parse(persisted)[0].expectedSha256).toBe(sha256(original))
    // A byte at 128 KiB is outside first/middle/last 64 KiB fingerprint samples.
    const changed = original.slice()
    changed[128 * 1024] ^= 0xff
    expect(sha256(changed)).not.toBe(sha256(original))
    const restored = queue(copied)
    await restored.reselect(id, makeFile(changed))
    await vi.waitFor(() => expect(item(restored, id).state).toBe('needs-file'))
    expect(item(restored, id).error).toContain('Контрольная сумма выбранного файла отличается')
    expect(backend.chunkCalls()).toHaveLength(1)
    expect(backend.admissionCalls()).toHaveLength(1)
    expect(backend.calls.some((call) => call.url?.endsWith('/complete'))).toBe(false)
    releaseChunk()
    await vi.waitFor(() => expect(item(q, id).state).toBe('paused'))
  })
})
