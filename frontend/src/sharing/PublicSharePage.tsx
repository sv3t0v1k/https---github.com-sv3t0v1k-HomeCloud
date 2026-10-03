import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { Icon } from '../ui/Icon'
import { formatBytes } from '../ui/formatBytes'
import { ApiError } from '../api/errors'
import { BrowserDownloadLimitError, MAX_BROWSER_BLOB_DOWNLOAD_BYTES } from '../files/download'
import { downloadPublicShare, getPublicShare, getSharedChildren, verifyPublicShare, type PublicShare, type SharedChildren } from './publicShareApi'

export function PublicSharePage() {
  const { token = '' } = useParams()
  return <PublicShareContent key={token} token={token} />
}

function PublicShareContent({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShare | null>(null)
  const [password, setPassword] = useState('')
  const [verifiedPassword, setVerifiedPassword] = useState<string | null>(null)
  const [children, setChildren] = useState<SharedChildren | null>(null)
  const [trail, setTrail] = useState<{ id: number; name: string }[]>([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const requestEpoch = useRef(0)
  const mutationController = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const parentId = trail[trail.length - 1]?.id

  useEffect(() => {
    const controller = new AbortController()
    requestEpoch.current += 1
    mutationController.current?.abort(); lock.current = false; setBusy(false); setChildren(null)
    setShare(null); setVerifiedPassword(null); setPassword(''); setTrail([]); setOffset(0); setLoading(true); setError(null); setNotice(null)
    getPublicShare(token, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setShare(data)
      if (!data.requiresPassword) setVerifiedPassword('')
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(publicError(cause)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); mutationController.current?.abort(); requestEpoch.current += 1 }
  }, [token, retry])

  useEffect(() => {
    if (!share?.isFolder || verifiedPassword === null) return
    const controller = new AbortController()
    setLoading(true); setError(null); setChildren(null)
    getSharedChildren(token, verifiedPassword, parentId, offset, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setChildren(data) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(publicError(cause)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [share, token, verifiedPassword, parentId, offset])

  async function verify(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    const epoch = requestEpoch.current
    const controller = new AbortController(); mutationController.current = controller
    try {
      const result = await verifyPublicShare(token, password, controller.signal)
      if (epoch !== requestEpoch.current) return
      if (!result.success) { setError('Неверный пароль. Попробуйте ещё раз.'); return }
      setShare((current) => current ? { ...current, ...(result.resource ? { resource: result.resource } : {}) } : current)
      setVerifiedPassword(password); setPassword('')
    } catch (cause) { if (epoch === requestEpoch.current) setError(publicError(cause)) }
    finally { if (epoch === requestEpoch.current) { lock.current = false; setBusy(false); mutationController.current = null } }
  }
  async function download(fileId?: number, name?: string) {
    if (lock.current || verifiedPassword === null) return
    lock.current = true; setBusy(true); setError(null); setNotice(null)
    const epoch = requestEpoch.current
    const controller = new AbortController(); mutationController.current = controller
    try { await downloadPublicShare(token, verifiedPassword, fileId, name, controller.signal); if (epoch !== requestEpoch.current) return; setNotice('Скачивание подготовлено.') }
    catch (cause) { if (epoch === requestEpoch.current) setError(publicError(cause)) }
    finally { if (epoch === requestEpoch.current) { lock.current = false; setBusy(false); mutationController.current = null } }
  }
  function navigate(depth: number) { setTrail((current) => current.slice(0, depth)); setOffset(0); setNotice(null) }

  const protectedResource = share?.requiresPassword && verifiedPassword === null
  const title = share?.resource?.name || (protectedResource ? 'Доступ защищён паролем' : share?.isFolder ? 'Общая папка' : !share && !loading ? 'Ссылка недоступна' : 'Файл по ссылке')
  const oversized = !share?.isFolder && share?.resource?.size != null && Number(share.resource.size) > MAX_BROWSER_BLOB_DOWNLOAD_BYTES
  return <main className="public-share-page">
    <div className="public-share-layout">
      <header className="public-share-brand"><Icon name="cloud" width="28" height="28" /><span>HomeCloud</span></header>
      <section className="public-share-card" aria-labelledby="share-title" aria-busy={loading || busy}>
        <div className="public-share-symbol"><Icon name={protectedResource ? 'lock' : share?.isFolder ? 'folder' : 'file'} width="32" height="32" /></div>
        <p className="public-share-kicker">{protectedResource ? 'Защищённая ссылка' : share?.isFolder ? 'Общая папка' : 'Общий доступ'}</p>
        <h1 id="share-title" className="public-share-title" title={title}>{title}</h1>
        {share?.resource && !protectedResource ? <p className="public-share-metadata">{share.isFolder ? 'Скачивание папки архивом ZIP' : <>{share.resource.size !== null ? formatBytes(share.resource.size) : 'Размер не указан'}{share.resource.mimeType ? <> · <span>{share.resource.mimeType}</span></> : null}</>}</p> : null}
        {loading ? <p className="muted" role="status">Загружаем…</p> : null}
        {error ? <p id="share-error" className="alert alert--danger" role="alert">{error}</p> : null}
        {notice ? <p className="alert alert--success" role="status">{notice}</p> : null}
        {!share && !loading ? <button className="button button--ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Повторить</button> : null}
        {protectedResource ? <form className="public-share-password" onSubmit={(event) => void verify(event)}>
          <p className="muted">Введите пароль, который передал владелец ссылки.</p>
          <label className="field">Пароль ссылки<input className="input" type="password" autoComplete="current-password" aria-invalid={error ? true : undefined} aria-describedby={error ? 'share-error' : undefined} required maxLength={1024} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Проверяем…' : 'Открыть доступ'}</button>
        </form> : null}
        {share && verifiedPassword !== null ? <>
          <div className="public-share-actions"><button className="button button--primary" type="button" disabled={busy || oversized} onClick={() => void download()}><Icon name="download" />{busy ? 'Подготавливаем…' : share.isFolder ? 'Скачать папку ZIP' : 'Скачать файл'}</button></div>
          <p className="public-share-limit">{oversized ? 'Файл превышает лимит скачивания в браузере 100 МиБ.' : 'Скачивание в браузере: до 100 МиБ, включая архив папки.'}</p>
          {share.isFolder ? <div className="public-share-folder">
            <nav aria-label="Путь общей папки" className="public-share-navigation">
              <button className="button button--ghost" type="button" disabled={loading || busy} onClick={() => navigate(0)}>Общая папка</button>
              {trail.map((entry, index) => <button className="button button--ghost" key={entry.id} type="button" disabled={loading || busy} onClick={() => navigate(index + 1)}>{entry.name}</button>)}
            </nav>
            {error && !loading ? <button className="button button--ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Повторить загрузку</button> : null}
            {children?.items.length === 0 ? <p className="muted">Папка пуста.</p> : null}
            <ul className="public-share-items">{children?.items.map((item) => <li key={`${item.kind}-${item.id}`} className="public-share-item">
              <Icon name={item.kind === 'folder' ? 'folder' : 'file'} />
              <div className="public-share-item-copy"><span title={item.name}>{item.name}</span><small>{item.kind === 'folder' ? 'Папка' : item.size === null ? 'Размер не указан' : formatBytes(item.size)}</small></div>
              {item.kind === 'folder' ? <button className="button button--ghost" aria-label={`Открыть ${item.name}`} type="button" disabled={busy || loading} onClick={() => { setTrail((current) => [...current, { id: item.id, name: item.name }]); setOffset(0) }}>Открыть</button>
                : <button className="button button--ghost" aria-label={`Скачать ${item.name}`} type="button" disabled={busy || Number(item.size) > MAX_BROWSER_BLOB_DOWNLOAD_BYTES} title={Number(item.size) > MAX_BROWSER_BLOB_DOWNLOAD_BYTES ? 'Файл превышает лимит браузера 100 МиБ' : undefined} onClick={() => void download(item.id, item.name)}>Скачать</button>}
            </li>)}</ul>
            {children ? <nav aria-label="Страницы общей папки" className="public-share-navigation">
              <button className="button button--ghost" type="button" disabled={busy || loading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Предыдущая страница</button>
              <button className="button button--ghost" type="button" disabled={busy || loading || !children.hasMore} onClick={() => setOffset((value) => value + 50)}>Следующая страница</button>
            </nav> : null}
          </div> : null}
        </> : null}
      </section>
      <footer className="public-share-footer">Безопасный доступ через HomeCloud</footer>
    </div>
  </main>
}

function publicError(cause: unknown): string {
  if (cause instanceof BrowserDownloadLimitError) return 'Размер скачивания превышает лимит браузера 100 МиБ.'
  if (cause instanceof ApiError) {
    if (cause.status === 404 || cause.status === 410) return 'Ссылка недоступна: доступ закрыт или срок действия истёк.'
    if (cause.status === 401 || cause.status === 403) return 'Пароль неверен или доступ по ссылке ограничен.'
    if (cause.status === 429) return 'Слишком много попыток. Попробуйте позже.'
    if (cause.status === 400) return 'Скачивание недоступно. Проверьте пароль и ограничения ссылки.'
  }
  return 'Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.'
}
