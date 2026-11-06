import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { Icon } from '../ui/Icon'
import { ActionMenu } from '../ui/ActionMenu'
import { formatBytes } from '../ui/formatBytes'
import { PreviewModal } from './PreviewModal'
import { ShareDialog } from '../sharing/ShareDialog'
import type { ShareTarget } from '../sharing/api'
import { downloadOriginalFile } from './download'
import { searchOrigin } from './searchNavigation'
import { resolveSearchPath, type PathCache, type SearchCrumb } from './searchPath'
import { normalizeSearchQuery, parseSearchLocation, SEARCH_PAGE_SIZE, searchRetryAfter } from './searchApi'
import { useGlobalSearch } from './useGlobalSearch'
import type { SearchFile, SearchFolder } from './searchTypes'
import './global-search.css'

type Result = { kind: 'file'; item: SearchFile } | { kind: 'folder'; item: SearchFolder }
type PathState = { result: Result; status: 'loading' | 'ready' | 'error'; crumbs: SearchCrumb[]; error?: ApiError; retryAt?: number }

export function GlobalSearchPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const parsed = parseSearchLocation(new URLSearchParams(location.search))
  const committed = parsed.query
  const focusSearch = Boolean(location.state && (location.state as { focusSearch?: boolean }).focusSearch)
  const [draft, setDraft] = useState(committed ?? '')
  const [validation, setValidation] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const { status, data, error, retry, cooldownUntil } = useGlobalSearch(parsed.error ? null : committed, parsed.offset)
  const [now, setNow] = useState(Date.now())
  const [preview, setPreview] = useState<SearchFile | null>(null)
  const [share, setShare] = useState<ShareTarget | null>(null)
  const [path, setPath] = useState<PathState | null>(null)
  const [pathRevision, setPathRevision] = useState(0)
  const pathCache = useRef<PathCache>(new Map())
  const [downloadId, setDownloadId] = useState<number | null>(null)
  const downloadBusy = useRef(false)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const alive = useRef(true)
  const scrollRestored = useRef(false)
  const returnTo = searchOrigin(location.pathname, location.state)
  const busy = status === 'loading'
  const resultsDisabled = busy || status === 'error'
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const count = data ? data.files.length + data.folders.length : 0

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    setDraft(committed ?? '')
    setValidation(null); setPath(null); setPreview(null); setShare(null); setActionNotice(null)
    scrollRestored.current = false
    if (focusSearch) input.current?.focus({ preventScroll: true })
    else heading.current?.focus({ preventScroll: true })
  }, [committed, parsed.offset, focusSearch])
  useEffect(() => {
    if (Math.max(cooldownUntil, path?.retryAt ?? 0) <= Date.now()) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil, path?.retryAt])
  useEffect(() => {
    if (status !== 'ready' || scrollRestored.current) return
    scrollRestored.current = true
    const value = location.state as { searchScroll?: unknown; focusResult?: unknown; focusResults?: unknown; scrollResults?: unknown } | null
    if (typeof value?.searchScroll === 'number' && Number.isFinite(value.searchScroll) && value.searchScroll >= 0) {
      window.scrollTo?.({ top: value.searchScroll })
      if (typeof value.focusResult === 'string' && /^(file|folder):[1-9]\d*$/.test(value.focusResult)) {
        document.querySelector<HTMLButtonElement>(`[data-search-key="${value.focusResult}"] .search-result-name`)?.focus({ preventScroll: true })
      }
    } else if (value?.focusResults === true) {
      resultHeading.current?.focus({ preventScroll: true })
      if (value.scrollResults === true) resultHeading.current?.scrollIntoView?.({ block: 'start' })
    }
  }, [status, location.state])

  const pathResult = path?.result
  useEffect(() => {
    if (!pathResult) return
    const controller = new AbortController()
    setPath({ result: pathResult, status: 'loading', crumbs: [] })
    resolveSearchPath(pathResult.item.parentId, pathCache.current, controller.signal).then(crumbs => {
      if (!controller.signal.aborted) setPath({ result: pathResult, status: 'ready', crumbs })
    }).catch(cause => {
      if (!controller.signal.aborted) setPath({ result: pathResult, status: 'error', crumbs: [], error: cause instanceof ApiError ? cause : new ApiError('Path unavailable', 'unknown'), retryAt: cause instanceof ApiError && cause.status === 429 ? searchRetryAfter(cause.retryAfter) : undefined })
    })
    return () => controller.abort()
  }, [pathResult, pathRevision])

  function submit(event: FormEvent) {
    event.preventDefault()
    const query = normalizeSearchQuery(draft)
    if (!query) { setValidation(draft.trim().length < 2 ? 'Введите не меньше двух символов.' : 'Название должно содержать не больше 100 символов без управляющих знаков.'); input.current?.focus(); return }
    setValidation(null)
    if (remaining || busy) return
    if (query === committed && parsed.offset === 0 && !parsed.error) { retry(); return }
    navigate(`/files/search?${new URLSearchParams({ q: query })}`, { state: { returnTo, focusResults: true } })
  }

  function navigateFromResult(result: Result, destination: string, extra: Record<string, unknown> = {}) {
    const current = `${location.pathname}${location.search}`
    navigate(current, { replace: true, state: { returnTo, searchScroll: window.scrollY, focusResult: `${result.kind}:${result.item.id}` } })
    navigate(destination, { state: { ...extra, searchReturn: current } })
  }
  function openResult(result: Result) {
    if (result.kind === 'folder') navigateFromResult(result, `/files/folders/${result.item.id}`)
    else setPreview(result.item)
  }
  function showInFolder(result: Result, crumbs?: SearchCrumb[]) {
    navigateFromResult(result, result.item.parentId === null ? '/files' : `/files/folders/${result.item.parentId}`, {
      target: { kind: result.kind, id: result.item.id }, ...(crumbs ? { crumbs } : {}),
    })
  }
  function changePage(offset: number) {
    if (!committed || busy || remaining) return
    navigate(`/files/search?${new URLSearchParams({ q: committed, ...(offset ? { offset: String(offset) } : {}) })}`, { state: { returnTo, focusResults: true, scrollResults: true } })
    resultHeading.current?.focus({ preventScroll: true })
  }
  async function download(file: SearchFile) {
    if (downloadBusy.current) return
    downloadBusy.current = true; setDownloadId(file.id); setActionNotice(null)
    try {
      await downloadOriginalFile(file)
      if (alive.current) setActionNotice('Скачивание передано браузеру. Состояние смотрите в его загрузках.')
    } catch (cause) {
      if (alive.current) setActionNotice(cause instanceof ApiError && cause.status === 404 ? 'Этот файл больше недоступен. Обновите результаты.' : 'Не удалось подготовить скачивание. Повторите попытку.')
    } finally { downloadBusy.current = false; if (alive.current) setDownloadId(null) }
  }

  function closePath() {
    if (path) document.querySelector<HTMLButtonElement>(`[data-search-key="${path.result.kind}:${path.result.item.id}"] .search-result-path`)?.focus()
    setPath(null)
  }

  function locationPanel() {
    return path && !busy ? <div className="search-location-panel" id="search-result-location" aria-label={`Расположение: ${path.result.item.name}`} role="region"><div className="search-location-header"><h3>Расположение</h3><button className="icon-button" aria-label="Закрыть расположение" type="button" onClick={closePath}><Icon name="close" /></button></div><p className="search-location-name">{path.result.item.name}</p>{path.status === 'loading' ? <p role="status">Загружаем путь…</p> : path.status === 'error' ? <><p role="alert">{path.error?.status === 429 ? 'Загрузка пути ограничена. Повторите позже.' : 'Расположение изменилось или недоступно. Обновите результаты.'}</p><button className="button button--ghost" type="button" disabled={(path.retryAt ?? 0) > now} onClick={() => setPathRevision(value => value + 1)}>Повторить загрузку пути</button></> : <><nav aria-label="Путь к найденному объекту"><ol className="search-path"><li><Link to="/files">Мои файлы</Link></li>{path.crumbs.map(crumb => <li key={crumb.id}><span aria-hidden="true">/</span><Link to={`/files/folders/${crumb.id}`}>{crumb.name}</Link></li>)}<li><span aria-hidden="true">/</span><span>{path.result.item.name}</span></li></ol></nav><button className="button button--ghost" type="button" onClick={() => showInFolder(path.result, path.crumbs)}>Показать в папке<Icon name="chevron" /></button></>}</div> : null
  }

  function rows(results: Result[], label: string) {
    if (!results.length) return null
    return <section className="search-result-group" aria-label={label}><h3>{label}</h3><ul className="search-result-list">{results.map(result => <li key={`${result.kind}:${result.item.id}`} data-search-key={`${result.kind}:${result.item.id}`} className="search-result-row">
      <span className={`file-icon file-icon-${result.kind === 'folder' ? 'folder' : result.item.mimeType?.startsWith('image/') ? 'image' : 'file'}`}><Icon name={result.kind === 'folder' ? 'folder' : 'file'} /></span>
      <div className="search-result-copy"><button className="search-result-name" aria-label={result.item.name} disabled={resultsDisabled} onClick={() => openResult(result)} type="button"><HighlightedName name={result.item.name} query={committed ?? ''} /></button><div className="search-result-meta">{result.kind === 'folder' ? 'Папка' : `${fileType(result.item.mimeType)} · ${formatBytes(result.item.size)}`}<span aria-hidden="true"> · </span><time dateTime={result.item.updatedAt}>{formatDate(result.item.updatedAt)}</time></div></div>
      <button className="button button--ghost search-result-path" disabled={resultsDisabled} onClick={() => setPath(current => current?.result.kind === result.kind && current.result.item.id === result.item.id ? null : { result, status: 'loading', crumbs: [] })} aria-expanded={path?.result.kind === result.kind && path.result.item.id === result.item.id} aria-controls="search-result-location" aria-label={`Путь: ${result.item.name}`} type="button"><Icon name="folder" /><span>{result.item.parentId === null ? 'Мои файлы' : 'Расположение'}</span></button>
      <ActionMenu label={`Действия: ${result.item.name}`} disabled={resultsDisabled} items={[
        { label: result.kind === 'folder' ? 'Открыть папку' : 'Предпросмотр', icon: result.kind === 'folder' ? 'folder' : 'file', onSelect: () => openResult(result) },
        { label: 'Показать в папке', icon: 'move', onSelect: () => showInFolder(result) },
        ...(result.kind === 'file' ? [{ label: downloadId === result.item.id ? 'Подготавливаем…' : 'Скачать', icon: 'download' as const, disabled: downloadId !== null, onSelect: () => void download(result.item) }] : []),
        { label: 'Поделиться', icon: 'link', onSelect: () => setShare({ fileId: result.kind === 'folder' ? result.item.shareFileId : result.item.id, name: result.item.name, isFolder: result.kind === 'folder' }) },
      ]} />
      {path?.result.kind === result.kind && path.result.item.id === result.item.id ? locationPanel() : null}
    </li>)}</ul></section>
  }

  return <section className="global-search-page" aria-labelledby="global-search-title">
    <Link className="search-back text-link" to={returnTo}><Icon name="arrow-left" />{returnTo === '/files' ? 'К моим файлам' : 'К исходной папке'}</Link>
    <header className="search-page-heading"><div><span className="search-eyebrow">Ваше облако</span><h1 id="global-search-title" ref={heading} tabIndex={-1}>Поиск</h1><p>Во всех моих файлах и папках</p></div><span className="search-scope"><Icon name="lock" />Только ваше пространство</span></header>
    <form className="search-form" role="search" aria-label="Глобальный поиск" onSubmit={submit}>
      <label htmlFor="global-search-query">Название файла или папки</label>
      <div className="search-input-row"><div className="search-input-wrap"><Icon name="search" /><input autoComplete="off" className="search-input" id="global-search-query" ref={input} type="search" maxLength={100} placeholder="Что нужно найти?" value={draft} onChange={event => { setDraft(event.target.value); setValidation(null) }} onKeyDown={event => { if (event.key === 'Escape') { setDraft(''); setValidation(null) } }} aria-invalid={Boolean(validation || parsed.error) || undefined} aria-describedby="global-search-help" /></div><button className="button button--primary search-submit" disabled={busy || remaining > 0} type="submit">{busy ? 'Ищем…' : 'Найти'}<Icon name="chevron" /></button></div>
      <p className={validation || parsed.error ? 'search-help is-error' : 'search-help'} id="global-search-help" role={validation || parsed.error ? 'alert' : undefined}>{validation || parsed.error || 'От 2 до 100 символов. Нажмите Enter, чтобы начать поиск.'}</p>
    </form>
    {actionNotice ? <p className="search-notice" role="status">{actionNotice}</p> : null}
    {error ? <div className="search-error" role="alert"><Icon name="search" /><div><h2>{searchErrorTitle(error)}</h2><p>{error.status === 429 ? <><span>Запрос сохранён. </span><span aria-hidden="true">{remaining > 0 ? `Повторить через ${remaining} с.` : 'Можно повторить поиск.'}</span><span className="sr-only">{remaining > 0 ? 'Дождитесь окончания ограничения.' : 'Можно повторить поиск.'}</span></> : searchErrorDetail(error)}</p><button className="button button--ghost" type="button" onClick={() => { if (error.status === 400) input.current?.focus(); else retry() }} disabled={remaining > 0}>{error.status === 400 ? 'Изменить запрос' : 'Повторить'}</button></div></div> : null}
    <div className="search-results" aria-busy={busy} style={busy && data ? { minHeight: Math.max(300, count * 82) } : undefined}>
      <div className="search-results-heading"><h2 ref={resultHeading} tabIndex={-1}>{committed ? <>Результаты для «{committed}»</> : 'Найдите нужное в своём облаке'}</h2>{data && count > 0 ? <span className="mono">{parsed.offset + 1}–{parsed.offset + count}</span> : null}</div>
      <p className="sr-only" role="status">{busy ? 'Поиск выполняется' : status === 'ready' ? count ? `На странице результатов: ${count}` : 'Совпадений не найдено' : ''}</p>
      {busy ? <div className="search-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(n => <div className="skeleton-row" key={n}><span className="skeleton-icon" /><span className="skeleton-line" /><span className="skeleton-line skeleton-short" /></div>)}</div> : null}
      {!busy && !committed && !parsed.error ? <div className="search-empty"><Icon name="search" /><h3>Файл рядом. Нужно вспомнить название.</h3><p>Ищите среди файлов и папок на любой глубине.<br />Результаты появятся после отправки запроса.</p></div> : null}
      {!busy && status === 'ready' && !count ? <div className="search-empty"><Icon name="search" /><h3>Ничего не найдено</h3><p>Попробуйте часть названия или другое написание.<br />Поиск учитывает название, а не содержимое файла.</p></div> : null}
      {data && !busy ? <>{status === 'error' ? <p className="search-help">Показаны предыдущие результаты. Обновите поиск перед открытием объекта.</p> : null}{rows(data.folders.map(item => ({ kind: 'folder', item })), 'Папки')}{rows(data.files.map(item => ({ kind: 'file', item })), 'Файлы')}</> : null}
    </div>

    {data && !busy && count ? <footer className="search-pagination"><span className="search-pagination-note">Папки идут первыми · по названию</span><nav aria-label="Страницы поиска"><button className="button button--ghost" disabled={parsed.offset === 0 || remaining > 0} onClick={() => changePage(Math.max(0, parsed.offset - SEARCH_PAGE_SIZE))} type="button"><Icon name="arrow-left" />Назад</button><button className="button button--ghost" disabled={!data.hasMore || parsed.offset + SEARCH_PAGE_SIZE > 10000 || remaining > 0} onClick={() => changePage(parsed.offset + SEARCH_PAGE_SIZE)} type="button">Дальше<Icon name="chevron" /></button></nav>{data.hasMore && parsed.offset + SEARCH_PAGE_SIZE > 10000 ? <p>Слишком много совпадений. Уточните название.</p> : null}</footer> : null}
    {preview ? <PreviewModal file={preview} onClose={() => setPreview(null)} /> : null}
    {share ? <ShareDialog target={share} onClose={() => setShare(null)} /> : null}
  </section>
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  const index = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  return index < 0 || !query ? name : <>{name.slice(0, index)}<mark>{name.slice(index, index + query.length)}</mark>{name.slice(index + query.length)}</>
}
function fileType(mimeType: string | null) { return mimeType?.startsWith('image/') ? 'Изображение' : mimeType?.startsWith('text/') ? 'Текст' : mimeType === 'application/pdf' ? 'PDF' : 'Файл' }
function formatDate(date: string) { const value = new Date(date); return Number.isNaN(value.getTime()) ? 'Дата неизвестна' : value.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) }
function searchErrorTitle(error: ApiError) { return error.status === 429 ? 'Поиск временно ограничен' : error.status === 400 ? 'Проверьте поисковый запрос' : error.status === 401 ? 'Сеанс завершён' : error.kind === 'network' ? 'Нет связи с сервером' : 'Поиск сейчас недоступен' }
function searchErrorDetail(error: ApiError) { return error.status === 400 ? 'Измените название или параметры страницы и повторите поиск.' : error.status === 401 ? 'Войдите в аккаунт снова.' : error.kind === 'network' ? 'Проверьте подключение. Запрос сохранён, его можно повторить.' : 'Сервер не смог выполнить поиск. Повторите немного позже.' }
