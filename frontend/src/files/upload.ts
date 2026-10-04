import { ApiError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem } from '../types/files'

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
  maxFileBytes: number | null
  maxActiveBytes: number | null
  maxChunkBytes: number
  maxChunks: number
  remainingActiveBytes: number | null
  quotaRemainingBytes: number
  effectiveMaxFileBytes: number
}

export function getUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  return apiRequest<UploadLimits>({ method: 'GET', url: '/uploads/limits', signal })
}

interface UploadSession {
  uploadId: string
  totalChunks: number
}

export type UploadStage = 'preparing' | 'uploading' | 'completing' | 'success'

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

  const payload: Record<string, string | number> = {
    filename: file.name,
    totalSize: file.size,
    chunkSize,
  }
  if (parentId !== undefined) payload.parentId = parentId

  const session = await apiRequest<UploadSession>({
    method: 'POST',
    url: '/uploads/session',
    data: payload,
    signal,
  })

  try {
    const retryBudget: RetryBudget = { remainingWaitMs: UPLOAD_RETRY_WAIT_BUDGET_MS }
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
            signal,
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
    const completed = await apiRequest<FileItem>({
      method: 'POST',
      url: `/uploads/session/${encodeURIComponent(session.uploadId)}/complete`,
      signal,
    })
    emit(onProgress, 'success', file.size, file.size, null, totalChunks)
    return completed
  } catch (error) {
    // Every terminal failure must release the server-side quota reservation.
    // Preserve the original error: cleanup is intentionally best effort.
    await abortSession(session.uploadId)
    throw error
  }
}

export async function withChunkRetry(
  send: () => Promise<unknown>,
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
      await send()
      budget.notBefore = undefined
      return
    } catch (error) {
      if (!isRetryable(error)) throw error
      const fallbackMs = Math.max(
        error.kind === 'rate-limit' ? DEFAULT_RETRY_DELAY_MS : 0,
        Number.isFinite(retryDelayMs) ? retryDelayMs : DEFAULT_RETRY_DELAY_MS,
      ) * 2 ** (attempt - 1)
      const delayMs = Math.max(fallbackMs, retryAfterDelay(error.retryAfter) ?? 0)
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
}

function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError &&
    (error.kind === 'network' || error.kind === 'server' || error.kind === 'rate-limit')
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
