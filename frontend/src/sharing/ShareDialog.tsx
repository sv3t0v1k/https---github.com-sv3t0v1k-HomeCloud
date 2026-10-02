import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/errors'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { createShare, listShares, publicShareUrl, revokeShare, type OwnerShare, type ShareTarget } from './api'

export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose(): void }) {
  const [shares, setShares] = useState<OwnerShare[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('7')
  const [maxDownloads, setMaxDownloads] = useState('')
  const mutationLock = useRef(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocus(onClose, closeButtonRef)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const all = await listShares(signal)
    setShares(all.filter((share) => share.fileId === target.fileId))
  }, [target.fileId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    refresh(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(shareErrorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (busy) closeButtonRef.current?.focus()
  }, [busy, dialogRef])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutationLock.current) return
    const expiry = Number(expiresInDays)
    const limit = maxDownloads === '' ? undefined : Number(maxDownloads)
    if (!Number.isInteger(expiry) || expiry < 1 || expiry > 36500) {
      setError('Укажите целое число дней от 1 до 36500.')
      return
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      setError('Лимит скачиваний должен быть положительным целым числом.')
      return
    }
    mutationLock.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await createShare({
        fileId: target.fileId,
        isFolder: target.isFolder,
        expiresInDays: expiry,
        ...(password ? { password } : {}),
        ...(limit === undefined ? {} : { maxDownloads: limit }),
      })
      setPassword('')
      await refresh()
      setNotice('Ссылка создана.')
    } catch (cause) {
      setPassword('')
      setError(shareErrorMessage(cause))
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  async function copy(share: OwnerShare) {
    setError(null)
    try {
      await navigator.clipboard.writeText(publicShareUrl(share.token))
      setNotice('Ссылка скопирована.')
    } catch {
      setError('Не удалось скопировать ссылку. Скопируйте её из поля вручную.')
    }
  }

  function open(share: OwnerShare) {
    window.open(publicShareUrl(share.token), '_blank', 'noopener,noreferrer')
  }

  async function revoke(share: OwnerShare) {
    if (mutationLock.current) return
    mutationLock.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await revokeShare(share.id)
      await refresh()
      setNotice('Доступ по ссылке закрыт.')
    } catch (cause) {
      setError(shareErrorMessage(cause))
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  return (
    <div aria-labelledby="share-title" aria-modal="true" className="dialog-overlay" ref={dialogRef} role="dialog" tabIndex={-1}>
      <div className="dialog-surface share-dialog">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">Общий доступ</p>
            <h3 id="share-title">Поделиться: {target.name}</h3>
            <p className="page-description">Настройте срок действия ссылки и ограничения скачивания.</p>
          </div>
          <button aria-label="Закрыть общий доступ" className="button button--ghost" onClick={onClose} ref={closeButtonRef} type="button">Закрыть</button>
        </header>
        <div className="dialog-body">
          <form className="share-form" onSubmit={(event) => void submit(event)}>
            <label className="field">Срок действия, дней<input className="input mono" max={36500} min={1} onChange={(event) => setExpiresInDays(event.target.value)} required type="number" value={expiresInDays} /></label>
            <label className="field">Лимит скачиваний (необязательно)<input className="input mono" min={1} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="Без ограничений" type="number" value={maxDownloads} /></label>
            <label className="field">Пароль (необязательно)<input autoComplete="new-password" className="input" maxLength={1024} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
            <button className="button button--primary share-create" disabled={busy} type="submit">{busy ? 'Сохраняем…' : 'Создать ссылку'}</button>
          </form>
          {error ? <p className="alert alert--danger" role="alert">{error}</p> : null}
          {notice ? <p className="alert alert--success" role="status">{notice}</p> : null}
          <section aria-labelledby="current-shares" className="share-links">
            <div className="section-heading"><h4 id="current-shares">Ссылки на этот объект</h4><span className="muted mono">{shares.length}</span></div>
            {loading ? <p className="loading-state" role="status">Загружаем ссылки…</p> : null}
            {!loading && shares.length === 0 ? <p className="empty-state">Для этого объекта пока нет ссылок.</p> : null}
            <ul className="share-list">
              {shares.map((share) => {
                const url = publicShareUrl(share.token)
                return <li className="share-card" key={share.id}>
                  <p className="share-status">{shareStatus(share)}</p>
                  <input aria-label={`Публичная ссылка: ${target.name}`} className="input mono" readOnly value={url} />
                  <p className="muted mono">Скачиваний: {String(share.downloadCount)}{share.maxDownloads === null ? '' : ` из ${String(share.maxDownloads)}`}</p>
                  <div className="share-actions"><button className="button button--ghost" onClick={() => void copy(share)} type="button">Копировать ссылку</button><button className="button button--ghost" onClick={() => open(share)} type="button">Открыть</button><button className="button button--danger" disabled={busy || !share.isActive} onClick={() => void revoke(share)} type="button">Закрыть доступ</button></div>
                </li>
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}

function shareStatus(share: OwnerShare): string {
  if (!share.isActive) return 'Доступ закрыт'
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return 'Срок действия истёк'
  if (share.maxDownloads !== null && Number(share.downloadCount) >= Number(share.maxDownloads)) return 'Лимит скачиваний исчерпан'
  return share.expiresAt ? `Действует до ${new Date(share.expiresAt).toLocaleDateString('ru-RU')}` : 'Без срока действия'
}

function shareErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Не удалось обновить доступ. Попробуйте ещё раз.'
  const message = cause.message.toLowerCase()
  if (cause.kind === 'authentication') return 'Сеанс завершён. Войдите снова.'
  if (cause.kind === 'authorization') return 'У вас нет разрешения открыть доступ к этому объекту.'
  if (cause.status === 404) return 'Объект или ссылка больше недоступны.'
  if (message.includes('maximum shareable size')) return 'Размер файла превышает лимит для общего доступа.'
  if (message.includes('type') && message.includes('sharing')) return 'Для этого типа файлов общий доступ недоступен.'
  if (cause.kind === 'validation') return 'Проверьте параметры доступа и попробуйте ещё раз.'
  if (cause.kind === 'network') return 'Сервер недоступен. Проверьте соединение и попробуйте ещё раз.'
  return 'Не удалось обновить доступ. Попробуйте ещё раз.'
}
