import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import type { FileItem } from '../types/files'
import { getUploadLimits, UPLOAD_CHUNK_SIZE, withChunkRetry, type RetryBudget } from './upload'

export type UploadQueueState = 'selected' | 'queued' | 'preparing' | 'uploading' | 'pausing' | 'paused' |
  'retrying' | 'completing' | 'completed' | 'error' | 'cancelling' | 'cancelled' | 'needs-file'

export interface UploadQueueItem {
  id: string
  name: string
  size: number
  parentId?: number
  state: UploadQueueState
  committedBytes: number
  percent: number
  needsFile: boolean
  error?: string
  uploadId?: string
  completedFile?: FileItem
}

interface Session {
  uploadId: string
  filename: string
  totalSize: number
  chunkSize: number
  totalChunks: number
  uploadedSize: number
  parentId?: number | null
  status: string
  expiresAt: string
  chunks?: { chunkIndex: number; byteSize: number; sha256: string }[]
  file?: FileItem
}

interface SavedUpload {
  id: string
  name: string
  size: number
  parentId?: number
  uploadId: string
  committedBytes: number
  fingerprint?: string
  lastModified?: number
  notBefore?: number
  cancellationPending?: boolean
}

interface Job {
  view: UploadQueueItem
  file?: File
  session?: Session
  fingerprint?: string
  lastModified?: number
  budget: RetryBudget
  control?: AbortController
  pauseRequested: boolean
  cancellationPending: boolean
  cancelling: boolean
  verifyCommitted: boolean
  busy: boolean
  creationUncertain?: boolean
}

const CONCURRENT_FILES = 2
const WAIT_BUDGET_MS = 300_000
const STORAGE_VERSION = 1
const SAMPLE_SIZE = 64 * 1024

/** Two files, one bounded chunk per file. Pause settles in-flight requests; Cancel deletes the session. */
export class UploadQueue {
  private jobs = new Map<string, Job>()
  private listeners = new Set<() => void>()
  private snapshot: readonly UploadQueueItem[] = []
  private active = 0
  private disposed = false
  private storage: Storage | null
  private storageKey: string
  private sequence = 0
  private discovery?: Promise<void>

  constructor(ownerId: number, storage?: Storage | null) {
    this.storageKey = `homecloud.uploads.v${STORAGE_VERSION}.owner.${ownerId}`
    this.storage = storage === undefined ? safeStorage() : storage
    this.restore()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): readonly UploadQueueItem[] => this.snapshot

  enqueue(files: File[], parentId?: number, start = true): string[] {
    if (this.disposed) return []
    const ids = files.map((file) => {
      const id = `local-${Date.now()}-${++this.sequence}`
      const valid = Number.isSafeInteger(file.size) && file.size > 0
      this.jobs.set(id, {
        view: { id, name: file.name, size: file.size, parentId, state: valid ? (start ? 'queued' : 'selected') : 'error',
          committedBytes: 0, percent: 0, needsFile: false,
          error: valid ? undefined : 'Пустые файлы пока не поддерживаются. Размер должен быть положительным.' },
        file, budget: { remainingWaitMs: WAIT_BUDGET_MS }, pauseRequested: false,
        cancellationPending: false, cancelling: false, verifyCommitted: false, busy: false,
      })
      return id
    })
    this.publish()
    this.pump()
    return ids
  }

  startAll() {
    if (this.disposed) return
    for (const job of this.jobs.values()) {
      if (job.view.state === 'selected') job.view.state = 'queued'
    }
    this.publish()
    this.pump()
  }

  pause(id: string) {
    const job = this.jobs.get(id)
    if (!job || terminal(job) || job.cancellationPending || job.view.state === 'completing') return
    job.pauseRequested = true
    job.control?.abort() // Interrupts waits only: in-flight HTTP requests settle normally.
    job.view.state = job.busy ? 'pausing' : 'paused'
    this.publish()
  }

  resume(id: string) {
    const job = this.jobs.get(id)
    if (!job || this.disposed || terminal(job) || job.busy) return
    if (job.cancellationPending) { this.cancel(id); return }
    if (job.creationUncertain) {
      job.view.error = 'Ответ создания сессии потерян. Найденные серверные загрузки показаны отдельно: выберите исходный файл в нужной строке. Отмените эту локальную строку.'
      this.publish()
      void this.discover().catch(() => { /* Retry is explicit; no duplicate create request. */ })
      return
    }
    if (!job.file) {
      job.view.state = 'needs-file'
      job.view.needsFile = true
      this.publish()
      return
    }
    if (!Number.isSafeInteger(job.file.size) || job.file.size <= 0) return
    job.pauseRequested = false
    job.view.error = undefined
    job.view.state = 'queued'
    job.verifyCommitted = Boolean(job.view.uploadId)
    // Explicit Resume opens a new bounded retry window, while retaining Retry-After.
    job.budget.remainingWaitMs = WAIT_BUDGET_MS
    this.publish()
    this.pump()
  }

  cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job || this.disposed || terminal(job) || job.cancelling) return
    job.cancellationPending = true
    job.pauseRequested = false
    job.view.error = undefined
    job.view.state = 'cancelling'
    job.control?.abort()
    this.publish()
    if (!job.busy) void this.finishCancellation(job)
  }

  async reselect(id: string, file: File): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || this.disposed || job.busy || terminal(job) || job.cancellationPending) return
    try {
      if (file.name !== job.view.name || file.size !== job.view.size) {
        throw new Error('Выберите исходный файл с тем же именем и размером.')
      }
      const fingerprint = await sampleFingerprint(file)
      if (job.fingerprint && fingerprint !== job.fingerprint) {
        throw new Error('Выбранный файл отличается от исходного. Загрузка не продолжена.')
      }
      if (this.disposed || job.cancellationPending || terminal(job)) return
      job.file = file
      job.fingerprint = fingerprint
      job.lastModified = file.lastModified
      job.view.needsFile = false
      job.verifyCommitted = true
      this.resume(id)
    } catch (error) {
      job.view.error = errorMessage(error)
      this.publish()
      throw error
    }
  }

  /** Discover owner-authorized server sessions, including a creation response lost to interruption. */
  discover(): Promise<void> {
    // Explicit authenticated remount reactivates the instance after StrictMode effect replay.
    this.disposed = false
    if (this.discovery) return this.discovery
    this.discovery = apiRequest<Session[] | { sessions: Session[] }>({ method: 'GET', url: '/uploads/sessions' })
      .then((result) => {
        if (this.disposed) return
        const sessions = Array.isArray(result) ? result : result.sessions
        for (const session of sessions) {
          if (!validSession(session)) continue
          // A delayed list response can predate accepted chunks or finalization.
          // Existing jobs reconcile via their own detail request; discovery only imports.
          if ([...this.jobs.values()].some((entry) => entry.view.uploadId === session.uploadId)) continue
          const id = `server-${session.uploadId}`
          const job = this.restoredJob({ id, name: session.filename, size: session.totalSize,
            parentId: session.parentId ?? undefined, uploadId: session.uploadId,
            committedBytes: session.uploadedSize })
          job.session = session
          this.jobs.set(id, job)
        }
        this.publish()
      })
      .finally(() => { this.discovery = undefined })
    return this.discovery
  }

  /** Logout/unmount retains safe metadata and sessions; it never means Cancel. */
  dispose() {
    this.disposed = true
    for (const job of this.jobs.values()) {
      if (terminal(job) || job.cancellationPending) continue
      job.pauseRequested = true
      job.control?.abort()
      job.view.state = job.busy ? 'pausing' : 'paused'
    }
    this.publish()
    this.listeners.clear()
  }

  private pump() {
    if (this.disposed) return
    for (const job of this.jobs.values()) {
      if (this.active >= CONCURRENT_FILES) break
      if (job.view.state !== 'queued' || job.busy || !job.file) continue
      job.busy = true
      this.active++
      job.control = new AbortController()
      void this.run(job).finally(async () => {
        job.busy = false
        job.control = undefined
        this.active--
        if (job.cancellationPending && job.view.state !== 'completed') await this.finishCancellation(job)
        this.publish()
        this.pump()
      })
    }
  }

  private async run(job: Job) {
    try {
      const file = job.file!
      job.view.state = 'preparing'
      this.publish()
      if (!job.view.uploadId) {
        job.fingerprint = await sampleFingerprint(file)
        job.lastModified = file.lastModified
        if (this.stopped(job)) return
        const limits = await getUploadLimits()
        if (this.stopped(job)) return
        if (!Number.isSafeInteger(limits.effectiveMaxFileBytes) || file.size > limits.effectiveMaxFileBytes) {
          throw new Error('Размер файла превышает доступную квоту или предел загрузки.')
        }
        if (!Number.isSafeInteger(limits.maxChunkBytes) || limits.maxChunkBytes <= 0 ||
          !Number.isSafeInteger(limits.maxChunks) || limits.maxChunks <= 0) throw new Error('Некорректные ограничения загрузки.')
        const chunkSize = Math.min(limits.maxChunkBytes, Math.max(UPLOAD_CHUNK_SIZE, Math.ceil(file.size / limits.maxChunks)))
        if (Math.ceil(file.size / chunkSize) > limits.maxChunks) throw new Error('Файл превышает предел числа частей.')
        job.creationUncertain = true
        const session = await apiRequest<Session>({ method: 'POST', url: '/uploads/session',
          data: { filename: file.name, totalSize: file.size, chunkSize,
            ...(job.view.parentId === undefined ? {} : { parentId: job.view.parentId }) } })
        job.creationUncertain = false
        job.view.uploadId = session.uploadId
        // Creation itself is non-retriable: a lost response is recovered by server discovery.
        job.session = { ...session, filename: file.name, totalSize: file.size, chunkSize,
          totalChunks: Math.ceil(file.size / chunkSize), uploadedSize: 0, chunks: [], parentId: job.view.parentId }
        this.publish()
      }
      if (this.stopped(job)) return
      let session = job.session!
      if (job.verifyCommitted || !session?.chunks) {
        session = await this.reconcile(job)
        if (terminal(job) || this.stopped(job)) return
        if (job.verifyCommitted) {
          for (const chunk of session.chunks ?? []) {
            if (this.stopped(job)) return
            const start = chunk.chunkIndex * session.chunkSize
            const hash = await digest(file.slice(start, Math.min(start + session.chunkSize, file.size)))
            if (hash !== chunk.sha256.toLowerCase()) {
              job.file = undefined
              job.view.needsFile = true
              throw new Error('Сохранённые части не совпадают с выбранным файлом. Выберите исходный файл.')
            }
          }
          job.verifyCommitted = false
        }
      }
      const accepted = new Set((session.chunks ?? []).map((chunk) => chunk.chunkIndex))
      for (let index = 0; index < session.totalChunks; index++) {
        if (this.stopped(job)) return
        if (accepted.has(index)) continue
        const start = index * session.chunkSize
        const chunk = file.slice(start, Math.min(start + session.chunkSize, file.size))
        job.view.state = 'uploading'
        this.publish()
        await withChunkRetry(async () => {
          if (this.stopped(job)) throw new DOMException('Upload paused', 'AbortError')
          job.view.state = 'uploading'
          this.publish()
          const form = new FormData()
          form.append('chunkIndex', String(index))
          form.append('chunk', chunk, file.name)
          await apiRequest({ method: 'POST', url: sessionUrl(session.uploadId, '/chunk'), data: form })
        }, job.control?.signal, 250, job.budget, () => {
          job.view.state = 'retrying'
          this.publish()
        })
        accepted.add(index)
        // The successful server response is the first point at which bytes become durable progress.
        job.view.committedBytes += chunk.size
        this.publish()
      }
      if (this.stopped(job)) return
      job.view.state = 'completing'
      this.publish()
      const completed = await apiRequest<FileItem>({ method: 'POST', url: sessionUrl(session.uploadId, '/complete') })
      // A late Pause/Cancel cannot pretend that a successfully finalized file is still an upload.
      job.cancellationPending = false
      job.view.state = 'completed'
      job.view.completedFile = completed
      job.view.committedBytes = file.size
      job.file = undefined
      job.view.needsFile = false
      this.publish()
    } catch (error) {
      job.verifyCommitted = Boolean(job.view.uploadId)
      if (job.creationUncertain && error instanceof ApiError && !['network', 'server'].includes(error.kind)) {
        job.creationUncertain = false
      }
      if (job.creationUncertain && !this.disposed) {
        void this.discover().catch(() => { /* Resume offers discovery again without another create. */ })
      }
      if (job.cancellationPending) return
      if (job.pauseRequested || this.disposed) {
        job.view.state = job.file ? 'paused' : 'needs-file'
      } else {
        job.view.state = job.file ? 'error' : 'needs-file'
        job.view.error = `${errorMessage(error)}${job.view.uploadId && !(error instanceof ApiError && /session.*expired|сесси.*истек/i.test(error.message)) ? ' Прогресс сохранён. Нажмите «Продолжить» или отмените загрузку.' : ''}`
      }
      this.publish()
    }
  }

  private async reconcile(job: Job, timeout?: number): Promise<Session> {
    const session = await apiRequest<Session>({ method: 'GET', url: sessionUrl(job.view.uploadId!), timeout })
    if (!validSession(session) || session.filename !== job.view.name || session.totalSize !== job.view.size ||
      (session.parentId ?? undefined) !== job.view.parentId) throw new Error('Параметры серверной сессии не совпадают с файлом.')
    if (session.status === 'completed' && session.file) {
      job.view.state = 'completed'
      job.view.completedFile = session.file
      job.view.committedBytes = job.view.size
      job.file = undefined
      job.cancellationPending = false
      job.view.needsFile = false
      this.publish()
      return session
    }
    if (!['pending', 'uploading'].includes(session.status)) throw new Error('Сессия больше не доступна для продолжения.')
    const chunks = session.chunks
    if (!Array.isArray(chunks)) throw new Error('Сервер не вернул сохранённые части загрузки.')
    const indexes = new Set<number>()
    let committed = 0
    for (const chunk of chunks) {
      const expectedSize = Math.min(session.chunkSize, session.totalSize - chunk.chunkIndex * session.chunkSize)
      if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= session.totalChunks ||
        indexes.has(chunk.chunkIndex) || chunk.byteSize !== expectedSize || !/^[a-f\d]{64}$/i.test(chunk.sha256)) {
        throw new Error('Сервер вернул некорректные данные сохранённых частей.')
      }
      indexes.add(chunk.chunkIndex)
      committed += chunk.byteSize
    }
    if (committed !== session.uploadedSize) throw new Error('Серверный прогресс загрузки не согласован.')
    job.session = session
    job.view.committedBytes = committed
    this.publish()
    return session
  }

  private stopped(job: Job): boolean {
    if (!job.pauseRequested && !job.cancellationPending && !this.disposed) return false
    job.view.state = job.cancellationPending ? 'cancelling' : (job.file ? 'paused' : 'needs-file')
    this.publish()
    return true
  }

  private async finishCancellation(job: Job) {
    if (job.cancelling || terminal(job)) return
    job.cancelling = true
    try {
      if (job.view.uploadId) {
        const control = new AbortController()
        let timeout: ReturnType<typeof window.setTimeout> | undefined
        const deadline = Date.now() + 10_000
        try {
          await Promise.race([
            withChunkRetry(() => apiRequest({ method: 'DELETE', url: sessionUrl(job.view.uploadId!),
              signal: control.signal, timeout: Math.max(1, deadline - Date.now()) }), control.signal, 250,
            { remainingWaitMs: 10_000, deadline }),
            new Promise<never>((_resolve, reject) => {
              timeout = window.setTimeout(() => {
                control.abort()
                reject(new Error('Сервер не подтвердил отмену за отведённое время.'))
              }, 10_000)
            }),
          ])
        } finally { window.clearTimeout(timeout); control.abort() }
      }
      job.view.state = 'cancelled'
      job.view.needsFile = false
      job.file = undefined
      job.cancellationPending = false
      job.view.error = undefined
    } catch (error) {
      // Finalization may have succeeded before its response was lost. A failed
      // DELETE must not trap an already stored file in cancellation forever.
      try {
        await this.reconcile(job, 5_000)
        if (job.view.state === 'completed') return
      } catch { /* Keep the original cancellation failure until server confirmation. */ }
      job.view.state = 'error'
      job.view.error = `Не удалось подтвердить отмену: ${errorMessage(error)} Нажмите «Отменить» повторно.`
      // Persist this intent: do not convert an unconfirmed cancellation into a resumable upload.
      job.cancellationPending = true
    } finally {
      job.cancelling = false
      this.publish()
    }
  }

  private publish() {
    this.snapshot = [...this.jobs.values()].map((job) => {
      job.view.percent = job.view.state === 'completed' ? 100 : Math.min(99, Math.floor(job.view.committedBytes / job.view.size * 100) || 0)
      return { ...job.view }
    })
    const saved: SavedUpload[] = [...this.jobs.values()].filter((job) => job.view.uploadId && !terminal(job))
      .map((job) => ({ id: job.view.id, name: job.view.name, size: job.view.size, parentId: job.view.parentId,
        uploadId: job.view.uploadId!, committedBytes: job.view.committedBytes, fingerprint: job.fingerprint,
        lastModified: job.lastModified, notBefore: job.budget.notBefore, cancellationPending: job.cancellationPending }))
    try {
      if (saved.length) this.storage?.setItem(this.storageKey, JSON.stringify(saved))
      else this.storage?.removeItem(this.storageKey)
    } catch { /* Storage-disabled/private browsers keep same-page uploads fully functional. */ }
    for (const listener of this.listeners) listener()
  }

  private restore() {
    try {
      const raw = this.storage?.getItem(this.storageKey)
      if (!raw) return
      const saved: unknown = JSON.parse(raw)
      if (!Array.isArray(saved)) return
      for (const value of saved) {
        if (!validSaved(value)) continue
        this.jobs.set(value.id, this.restoredJob(value))
      }
      this.publish()
    } catch { /* Corrupt or unavailable local metadata must not block ordinary uploads. */ }
  }

  private restoredJob(saved: SavedUpload): Job {
    return { view: { id: saved.id, name: saved.name, size: saved.size, parentId: saved.parentId,
      uploadId: saved.uploadId, committedBytes: saved.committedBytes, percent: 0, needsFile: true,
      state: saved.cancellationPending ? 'error' : 'needs-file',
      error: saved.cancellationPending ? 'Отмена не подтверждена сервером. Нажмите «Отменить» повторно.' : undefined },
      fingerprint: saved.fingerprint, lastModified: saved.lastModified,
      budget: { remainingWaitMs: WAIT_BUDGET_MS, notBefore: saved.notBefore }, pauseRequested: true,
      cancellationPending: Boolean(saved.cancellationPending), cancelling: false, verifyCommitted: true, busy: false }
  }
}

function safeStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

function terminal(job: Job) { return job.view.state === 'completed' || job.view.state === 'cancelled' }
function sessionUrl(id: string, suffix = '') { return `/uploads/session/${encodeURIComponent(id)}${suffix}` }
function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (/upload session.*expired|session.*expired|сесси.*истек/i.test(error.message)) return 'Сессия загрузки истекла. Выберите файл и начните загрузку заново.'
    if (/file size|file.*too large|размер.*превыш|exceed.*maximum|exceed.*limit/i.test(error.message)) return 'Размер файла превышает допустимый предел загрузки.'
    if (/quota|storage.*exceeded|недостаточно.*мест|квот/i.test(error.message)) return 'Недостаточно места в хранилище.'
    if (error.kind === 'network') return 'Нет связи с сервером.'
    if (error.kind === 'server') return 'Временная ошибка сервера.'
    if (error.kind === 'authentication') return 'Авторизация истекла. Войдите снова.'
    if (error.kind === 'authorization') return 'Нет доступа к этой загрузке.'
    if (error.kind === 'rate-limit') return 'Сервер ограничил частоту запросов. Подождите и продолжите.'
    if (error.kind === 'validation') return 'Сервер отклонил загрузку. Проверьте имя файла, размер, папку и доступную квоту.'
    if (error.status === 404) return 'Сессия загрузки больше не доступна: она могла истечь.'
    return 'Не удалось выполнить запрос к серверу.'
  }
  return error instanceof Error ? error.message : 'Не удалось загрузить файл.'
}

function validSession(session: Session): boolean {
  return typeof session?.uploadId === 'string' && typeof session.filename === 'string' &&
    Number.isSafeInteger(session.totalSize) && session.totalSize > 0 && Number.isSafeInteger(session.chunkSize) &&
    session.chunkSize > 0 && session.totalChunks === Math.ceil(session.totalSize / session.chunkSize) &&
    Number.isSafeInteger(session.uploadedSize) && session.uploadedSize >= 0 && session.uploadedSize <= session.totalSize
}

function validSaved(value: unknown): value is SavedUpload {
  if (!value || typeof value !== 'object') return false
  const item = value as SavedUpload
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.uploadId === 'string' &&
    Number.isSafeInteger(item.size) && item.size > 0 && Number.isSafeInteger(item.committedBytes) &&
    item.committedBytes >= 0 && item.committedBytes <= item.size &&
    (item.parentId === undefined || (Number.isSafeInteger(item.parentId) && item.parentId > 0)) &&
    (item.fingerprint === undefined || /^[a-f\d]{64}$/i.test(item.fingerprint)) &&
    (item.notBefore === undefined || Number.isFinite(item.notBefore))
}

async function sampleFingerprint(file: File): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined
  const starts = [...new Set([0, Math.max(0, Math.floor(file.size / 2) - SAMPLE_SIZE / 2), Math.max(0, file.size - SAMPLE_SIZE)])]
  const samples: ArrayBuffer[] = []
  for (const start of starts) samples.push(await readBlob(file.slice(start, Math.min(file.size, start + SAMPLE_SIZE))))
  const combined = new Uint8Array(samples.reduce((size, buffer) => size + buffer.byteLength, 0))
  let offset = 0
  for (const buffer of samples) { combined.set(new Uint8Array(buffer), offset); offset += buffer.byteLength }
  return hashBytes(combined)
}

async function digest(blob: Blob): Promise<string> { return hashBytes(new Uint8Array(await readBlob(blob))) }
async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Браузер не может проверить целостность файла. Используйте защищённое HTTPS-подключение.')
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('Не удалось прочитать локальный файл.'))
    reader.readAsArrayBuffer(blob)
  })
}
