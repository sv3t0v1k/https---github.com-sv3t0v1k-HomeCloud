import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
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

  return <main className="auth-page"><section className="dialog-surface" style={{ width: 'min(100%, 760px)', minWidth: 0, padding: 24 }}>
    <h1 className="page-heading">HomeCloud · Общий доступ</h1>
    <p className="page-description">{share?.isFolder ? 'Общая папка' : 'Файл по ссылке'}</p>
    {loading ? <p role="status">Загружаем…</p> : null}
    {error ? <p className="alert alert--danger" role="alert">{error}</p> : null}
    {notice ? <p className="alert alert--success" role="status">{notice}</p> : null}
    {!share && !loading ? <button className="button button--ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Повторить</button> : null}
    {share?.requiresPassword && verifiedPassword === null ? <form className="auth-form" onSubmit={(event) => void verify(event)}>
      <label className="field">Пароль ссылки<input className="input" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Проверяем…' : 'Открыть доступ'}</button>
    </form> : null}
    {share && verifiedPassword !== null ? <>
      <button className="button button--primary" type="button" disabled={busy} onClick={() => void download()}>{busy ? 'Подготавливаем…' : share.isFolder ? 'Скачать папку ZIP' : 'Скачать файл'}</button>
      <p className="muted">Скачивание в браузере: до 100 МиБ, включая архив папки.</p>
      {share.isFolder ? <>
        <nav aria-label="Путь общей папки" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="button button--ghost" type="button" disabled={loading || busy} onClick={() => navigate(0)}>Общая папка</button>
          {trail.map((entry, index) => <button className="button button--ghost" key={entry.id} type="button" disabled={loading || busy} onClick={() => navigate(index + 1)}>{entry.name}</button>)}
        </nav>
        {error && !loading ? <button className="button button--ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Повторить загрузку</button> : null}
        {children?.items.length === 0 ? <p>Папка пуста.</p> : null}
        <ul style={{ padding: 0, listStyle: 'none' }}>{children?.items.map((item) => <li key={`${item.kind}-${item.id}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', paddingBlock: 8 }}>
          <span style={{ flex: '1 1 180px', overflowWrap: 'anywhere' }}>{item.name}</span>
          {item.kind === 'folder' ? <button className="button button--ghost" type="button" disabled={busy || loading} onClick={() => { setTrail((current) => [...current, { id: item.id, name: item.name }]); setOffset(0) }}>Открыть {item.name}</button>
            : <button className="button button--ghost" type="button" disabled={busy || Number(item.size) > MAX_BROWSER_BLOB_DOWNLOAD_BYTES} title={Number(item.size) > MAX_BROWSER_BLOB_DOWNLOAD_BYTES ? 'Файл превышает лимит браузера 100 МиБ' : undefined} onClick={() => void download(item.id, item.name)}>Скачать {item.name}</button>}
        </li>)}</ul>
        {children ? <nav aria-label="Страницы общей папки" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="button button--ghost" type="button" disabled={busy || loading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Предыдущая страница</button>
          <button className="button button--ghost" type="button" disabled={busy || loading || !children.hasMore} onClick={() => setOffset((value) => value + 50)}>Следующая страница</button>
        </nav> : null}
      </> : null}
    </> : null}
  </section></main>
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
