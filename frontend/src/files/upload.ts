import { ApiError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem } from '../types/files'

export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024
const MAX_CHUNK_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250

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

  const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_SIZE)
  emit(onProgress, 'preparing', 0, file.size, null, totalChunks)

  const payload: Record<string, string | number> = {
    filename: file.name,
    totalSize: file.size,
    chunkSize: UPLOAD_CHUNK_SIZE,
  }
  if (parentId !== undefined) payload.parentId = parentId

  const session = await apiRequest<UploadSession>({
    method: 'POST',
    url: '/uploads/session',
    data: payload,
    signal,
  })

  try {
    let completedBytes = 0
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      throwIfAborted(signal)
      const start = chunkIndex * UPLOAD_CHUNK_SIZE
      const chunk = file.slice(start, Math.min(start + UPLOAD_CHUNK_SIZE, file.size))
      let furthestAttemptByte = 0

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
            onUploadProgress: ({ loaded }) => {
              furthestAttemptByte = Math.max(furthestAttemptByte, Math.min(loaded, chunk.size))
              emit(
                onProgress,
                'uploading',
                completedBytes + furthestAttemptByte,
                file.size,
                chunkIndex,
                totalChunks,
              )
            },
          })
        },
        signal,
        retryDelayMs,
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

async function withChunkRetry(
  send: () => Promise<void>,
  signal: AbortSignal | undefined,
  retryDelayMs: number,
) {
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    try {
      await send()
      return
    } catch (error) {
      if (signal?.aborted || attempt === MAX_CHUNK_ATTEMPTS || !isRetryable(error)) {
        throw error
      }
      await abortableDelay(retryDelayMs * attempt, signal)
    }
  }
}

function isRetryable(error: unknown) {
  return error instanceof ApiError && (error.kind === 'network' || error.kind === 'server')
}

async function abortSession(uploadId: string) {
  try {
    await apiRequest({
      method: 'DELETE',
      url: `/uploads/session/${encodeURIComponent(uploadId)}`,
    })
  } catch {
    // Cancellation is local and immediate; server cleanup is deliberately best effort.
  }
}

function validateFile(file: File) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new RangeError('File size must be a positive safe integer')
  }
  const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_SIZE)
  if (!Number.isSafeInteger(totalChunks) || totalChunks > 100_000) {
    throw new RangeError('File requires an unsafe number of upload chunks')
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout)
        reject(new DOMException('Upload cancelled', 'AbortError'))
      },
      { once: true },
    )
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
