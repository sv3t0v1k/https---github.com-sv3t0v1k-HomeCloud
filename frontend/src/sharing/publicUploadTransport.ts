import type { AxiosRequestConfig } from 'axios'
import { apiRequest } from '../api/client'
import type { FileItem } from '../types/files'
import type { UploadTransport } from '../files/uploadQueue'
import type { UploadLimits } from '../files/upload'

/** Memory only. This capability never discovers owner sessions or sends owner JWTs. */
export class PublicUploadTransport implements UploadTransport {
  private proof?: { proof: string; expiresAt: string }
  private pending?: Promise<void>
  private disposed = false
  private control = new AbortController()
  constructor(private token: string, private password: string) {}

  async authorize() {
    if (this.disposed) throw new Error('Страница закрыта.')
    if (this.proof && Date.parse(this.proof.expiresAt) > Date.now() + 30_000) return
    if (!this.pending) this.pending = apiRequest<{ proof: string; expiresAt: string }>({
      method: 'POST', url: this.base('/upload-authorizations'), data: { password: this.password },
      skipAuth: true, skipRefresh: true, signal: this.control.signal, timeout: 120_000,
    }).then((proof) => { if (!this.disposed) this.proof = proof }).finally(() => { this.pending = undefined })
    await this.pending
    if (this.disposed) throw new Error('Страница закрыта.')
  }

  async request<T>(config: AxiosRequestConfig): Promise<T> {
    await this.authorize()
    if (!/^\/uploads\/session(?:$|\/[^/]+(?:\/(?:chunk|complete))?$)/.test(config.url ?? '')) throw new Error('Недопустимая публичная операция.')
    return apiRequest<T>({ timeout: 120_000, ...config, url: this.base(config.url!), skipAuth: true, skipRefresh: true,
      signal: config.signal ?? this.control.signal, headers: { ...config.headers, 'X-Share-Upload-Proof': this.proof!.proof } })
  }

  async mkdir(parentId: number, name: string, key: string) {
    await this.authorize()
    return apiRequest<{ id: number; name: string; parentId: number }>({ method: 'POST', url: this.base('/folders'),
      data: { parentId, name }, headers: { 'X-Share-Upload-Proof': this.proof!.proof, 'Idempotency-Key': key },
      skipAuth: true, skipRefresh: true, signal: this.control.signal, timeout: 120_000 })
  }

  // Backend has no public limits projection. These are local selection bounds,
  // not claimed server limits; admission remains authoritative for quota/config.
  async limits(): Promise<UploadLimits> {
    return { wholeSha256Required: true, maxFileBytes: null, maxActiveBytes: null, maxChunkBytes: 10 * 1024 * 1024,
      maxChunks: 10000, remainingActiveBytes: null, quotaRemainingBytes: 0, effectiveMaxFileBytes: 10000 * 10 * 1024 * 1024 }
  }

  errorMessage = publicUploadError

  complete(uploadId: string, signal?: AbortSignal, _onReceipt?: (file: FileItem) => void, timeout = 30 * 60_000) {
    return this.request<FileItem>({ method: 'POST', url: `/uploads/session/${encodeURIComponent(uploadId)}/complete`, signal, timeout })
  }

  dispose() { this.disposed = true; this.password = ''; this.proof = undefined; this.control.abort() }
  private base(suffix: string) { return `/sharing/public/${encodeURIComponent(this.token)}${suffix}` }
}

export function publicUploadError(error: unknown): string {
  const status = (error as { status?: number })?.status
  if (status === 400 || status === 413) return 'Сервер отклонил параметры, размер или контрольную сумму файла. Проверьте ограничения у владельца.'
  if (status === 401 || status === 403) return 'Нет разрешения на запись, истёк доступ или недостаточно квоты владельца. Повторите после проверки доступа и места.'
  if (status === 404 || status === 410) return 'Ссылка, папка или загрузка недоступна: объект удалён, доступ отозван или срок истёк.'
  if (status === 409) return 'Конфликт операции: объект мог быть перемещён или срок повтора истёк. Уточните результат у владельца.'
  if (status === 429) return 'Достигнут лимит запросов, сессий или операций ссылки. Подождите; при повторном отказе обратитесь к владельцу.'
  if (status === 503) return 'Хранилище временно недоступно. Повторите позже.'
  if ((error as { kind?: string })?.kind === 'network') return 'Нет связи с сервером. Результат не подтверждён; повторите прежнюю операцию.'
  return error instanceof Error && !status ? error.message : 'Не удалось подтвердить результат. Проверьте соединение и повторите прежнюю операцию.'
}
