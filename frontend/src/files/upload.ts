import { ApiError, isUploadCapacityError, isUploadBusyError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem } from '../types/files'
import { hashFileSha256 } from './wholeSha256'

export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024
const MAX_CHUNK_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRY_WAIT_MS = 60_000
const UPLOAD_RETRY_WAIT_BUDGET_MS = 5 * 60_000
const ABORT_BUDGET_MS = 10_000
const RATE_LIMIT_MESSAGE = 'Сервер ограничил частоту загрузки. Подождите и повторите загрузку.'

export interface RetryBudget {
  remainingWaitMs: number
  deadline?: number
  /** Retained when a pause interrupts backoff, so Resume cannot retry early. */
  notBefore?: number
}

export interface UploadLimits {
  storageMode?: 'legacy' | 'ssd'
  wholeSha256Required?: boolean
  maxFileBytes: number | null
  maxActiveBytes: number | null
  maxChunkBytes: number
  maxChunks: number
  remainingActiveBytes: number | null
  quotaRemainingBytes: number
  effectiveMaxFileBytes: number
}

export function getUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  return apiRequest<UploadLimits>({ method: 'GET', url: '/uploads/limits', signal, timeout: 120_000 })
}

interface UploadSession {
  uploadId: string
  totalChunks: number
}

export type UploadStage = 'preparing' | 'hashing' | 'uploading' | 'completing' | 'success'

export interface UploadProgress {
  stage: UploadStage
  bytesSent: number
  totalBytes: number
  chunkIndex: number | null
  totalChunks: number
  percent: number
}

export interface UploadFileOptions {
  file: File
  parentId?: number
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
  /** Intended for deterministic tests; production callers should use the default. */
  retryDelayMs?: number
}

export async function uploadFile({
  file,
  parentId,
  signal,
  onProgress,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}: UploadFileOptions): Promise<FileItem> {
  validateFile(file)
  throwIfAborted(signal)

  const limits = await getUploadLimits(signal)
  if (!Number.isSafeInteger(limits.effectiveMaxFileBytes) || limits.effectiveMaxFileBytes < file.size) {
    throw new RangeError('Размер файла превышает доступное ограничение загрузки.')
  }
  if (!Number.isSafeInteger(limits.maxChunks) || limits.maxChunks <= 0 ||
      !Number.isSafeInteger(limits.maxChunkBytes) || limits.maxChunkBytes <= 0) {
    throw new RangeError('Недопустимые ограничения загрузки.')
  }
  const chunkSize = Math.min(limits.maxChunkBytes, Math.max(UPLOAD_CHUNK_SIZE, Math.ceil(file.size / limits.maxChunks)))
  const totalChunks = Math.ceil(file.size / chunkSize)
  if (totalChunks > limits.maxChunks) throw new RangeError('Размер файла превышает число допустимых частей.')
  emit(onProgress, 'preparing', 0, file.size, null, totalChunks)

  const retryBudget: RetryBudget = { remainingWaitMs: UPLOAD_RETRY_WAIT_BUDGET_MS }
  const payload: Record<string, string | number> = {
    filename: file.name,
    totalSize: file.size,
    chunkSize,
  }
  if (parentId !== undefined) payload.parentId = parentId

  if (limits.wholeSha256Required || limits.storageMode === 'ssd') {
    payload.expectedSha256 = await hashFileSha256(file, { signal, onProgress: (bytes) =>
      emit(onProgress, 'hashing', bytes, file.size, null, totalChunks) })
  }
  throwIfAborted(signal)
  // Retry only a definite pre-admission rejection; ambiguous create responses are not replayed.
  const session = await withAdmissionRetry(() => apiRequest<UploadSession>({
    method: 'POST',
    url: '/uploads/session',
    data: payload,
    signal, timeout: 120_000,
  }), signal, retryDelayMs, retryBudget)

  let finalizing = false
  try {
    let completedBytes = 0
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      throwIfAborted(signal)
      const start = chunkIndex * chunkSize
      const chunk = file.slice(start, Math.min(start + chunkSize, file.size))

      await withChunkRetry(
        async () => {
          const form = new FormData()
          form.append('chunkIndex', String(chunkIndex))
          form.append('chunk', chunk, file.name)
          await apiRequest({
            method: 'POST',
            url: `/uploads/session/${encodeURIComponent(session.uploadId)}/chunk`,
            data: form,
            signal, timeout: 120_000,
          })
        },
        signal,
        retryDelayMs,
        retryBudget,
      )
      completedBytes += chunk.size
      emit(onProgress, 'uploading', completedBytes, file.size, chunkIndex, totalChunks)
    }

    emit(onProgress, 'completing', file.size, file.size, null, totalChunks)
    finalizing = true
    const completed = await withChunkRetry(() => completeUploadSession(session.uploadId, signal), signal, retryDelayMs, retryBudget)
    emit(onProgress, 'success', file.size, file.size, null, totalChunks)
    return completed
  } catch (error) {
    // Before finalization, cleanup is bounded and best effort. Once publication
    // may have started, retain the session for explicit reconciliation/retry.
    if (!finalizing) await abortSession(session.uploadId)
    throw error
  }
}

export async function withChunkRetry<T>(
  send: () => Promise<T>,
  signal: AbortSignal | undefined,
  retryDelayMs: number,
  budget: RetryBudget,
  onRetry?: () => void,
) {
  const remainingBackoff = Math.max(0, (budget.notBefore ?? 0) - Date.now())
  if (remainingBackoff > MAX_RETRY_WAIT_MS) throw new ApiError(RATE_LIMIT_MESSAGE, 'rate-limit')
  if (remainingBackoff > 0) {
    onRetry?.()
    await abortableDelay(remainingBackoff, signal)
  }
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    if (budget.deadline !== undefined && Date.now() >= budget.deadline) {
      throw new ApiError('Upload cleanup retry budget exhausted', 'network')
    }
    try {
      const result = await send()
      budget.notBefore = undefined
      return result
    } catch (error) {
      if (!isRetryable(error)) throw error
      const fallbackMs = Math.max(
        error.kind === 'rate-limit' ? DEFAULT_RETRY_DELAY_MS : 0,
        Number.isFinite(retryDelayMs) ? retryDelayMs : DEFAULT_RETRY_DELAY_MS,
      ) * 2 ** (attempt - 1)
      // Positive jitter for 503 prevents synchronized clients; never retry before Retry-After.
      const jitteredMs = error.status === 503 ? Math.max(DEFAULT_RETRY_DELAY_MS, fallbackMs) * (1 + Math.random() * 0.25) : fallbackMs
      const delayMs = Math.max(jitteredMs, retryAfterDelay(error.retryAfter) ?? 0)
      budget.notBefore = Math.max(budget.notBefore ?? 0, Date.now() + delayMs)
      // Pause can arrive while the request is in flight. Retain the response's
      // Retry-After before interrupting scheduling, even when already paused.
      if (signal?.aborted) throw error
      if (attempt === MAX_CHUNK_ATTEMPTS) throw retryFailure(error)
      const availableMs = Math.min(
        budget.remainingWaitMs,
        budget.deadline === undefined ? Infinity : budget.deadline - Date.now(),
      )
      // Never clamp a server Retry-After to an earlier retry. Stop instead.
      if (delayMs > MAX_RETRY_WAIT_MS || delayMs > availableMs) throw retryFailure(error)
      budget.remainingWaitMs -= delayMs
      onRetry?.()
      await abortableDelay(delayMs, signal)
    }
  }
  throw new Error('Retry attempts exhausted')
}

function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError &&
    !isUploadCapacityError(error) &&
    (error.kind === 'network' || error.kind === 'server' || error.kind === 'busy' || error.kind === 'rate-limit')
}

function retryFailure(error: ApiError) {
  return error.kind === 'rate-limit'
    ? new ApiError(RATE_LIMIT_MESSAGE, 'rate-limit', error.status, error.retryAfter)
    : error
}

function retryAfterDelay(value: string | undefined): number | null {
  if (!value) return null
  const header = value.trim()
  if (/^\d+$/.test(header)) {
    // An overflowing numeric header is an excessive wait, not a malformed one.
    return Number(header) * 1000
  }
  // Accept HTTP dates, but do not interpret arbitrary numeric strings as dates.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(,|day,| )/i.test(header)) return null
  const timestamp = Date.parse(header)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null
}

async function abortSession(uploadId: string) {
  const deadline = Date.now() + ABORT_BUDGET_MS
  const controller = new AbortController()
  let timeout: ReturnType<typeof window.setTimeout> | undefined
  try {
    await Promise.race([
      withChunkRetry(
        () => apiRequest({
          method: 'DELETE',
          url: `/uploads/session/${encodeURIComponent(uploadId)}`,
          signal: controller.signal,
          timeout: Math.max(1, deadline - Date.now()),
        }),
        controller.signal,
        DEFAULT_RETRY_DELAY_MS,
        { remainingWaitMs: ABORT_BUDGET_MS, deadline },
      ),
      new Promise<void>((resolve) => {
        timeout = window.setTimeout(() => {
          controller.abort()
          resolve()
        }, ABORT_BUDGET_MS)
      }),
    ])
  } catch {
    // Preserve the upload error; cleanup has its own bounded, best-effort budget.
  } finally {
    window.clearTimeout(timeout)
    controller.abort()
  }
}

function validateFile(file: File) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new RangeError('File size must be a positive safe integer')
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function emit(
  callback: UploadFileOptions['onProgress'],
  stage: UploadStage,
  bytesSent: number,
  totalBytes: number,
  chunkIndex: number | null,
  totalChunks: number,
) {
  const rawPercent = Math.floor((bytesSent / totalBytes) * 100)
  callback?.({
    stage,
    bytesSent,
    totalBytes,
    chunkIndex,
    totalChunks,
    percent: stage === 'success' ? 100 : Math.min(rawPercent, 99),
  })
}

/** Read a lost publication receipt, then replay complete to release server cleanup barriers. */
export async function completeUploadSession(uploadId: string, signal?: AbortSignal, onReceipt?: (file: FileItem) => void, timeoutMs = 30 * 60_000): Promise<FileItem> {
  try {
    return await apiRequest<FileItem>({ method: 'POST', url: `/uploads/session/${encodeURIComponent(uploadId)}/complete`, signal, timeout: timeoutMs })
  } catch (error) {
    if (error instanceof ApiError && ['network', 'server', 'busy'].includes(error.kind)) {
      try {
        const receipt = await apiRequest<{ status: string; file?: FileItem }>({
          method: 'GET', url: `/uploads/session/${encodeURIComponent(uploadId)}`, signal, timeout: Math.min(120_000, timeoutMs) })
        if (receipt.status === 'completed' && receipt.file) onReceipt?.(receipt.file)
        // GET proves publication, but does not run SSD cleanup. Rethrow the
        // original failure so bounded retry preserves its Retry-After and
        // replays the idempotent complete endpoint before claiming completion.
      } catch { /* Keep original failure and use the same bounded replay budget. */ }
    }
    throw error
  }
}

/** No network/500 replay: the server does not expose an admission idempotency key. */
export async function withAdmissionRetry<T>(send: () => Promise<T>, signal: AbortSignal | undefined, delay: number, budget: RetryBudget, onRetry?: () => void): Promise<T> {
  return withChunkRetry(async () => {
    try { return { result: await send() } } catch (error) {
      if (isUploadBusyError(error) || (error instanceof ApiError && error.kind === 'rate-limit')) throw error
      return { error }
    }
  }, signal, delay, budget, onRetry).then((outcome) => {
    if ('error' in outcome) throw outcome.error
    return outcome.result
  })
}
