import { formatBytes } from '../ui/formatBytes'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { ActionMenu } from '../ui/ActionMenu'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { copyFile, createFolder, getFolder, getFolderContents, moveFile, moveFolder, moveToTrash, renameFile, renameFolder } from './api'
import { downloadOriginalFile } from './download'
import { getUploadLimits, uploadFile, type UploadLimits, type UploadProgress } from './upload'
import { ShareDialog } from '../sharing/ShareDialog'
import type { ShareTarget } from '../sharing/api'
import { PreviewModal } from './PreviewModal'
import { safeOperationError } from './operationErrors'

interface Crumb { id: number; name: string }
interface FolderLocationState { crumbs?: Crumb[] }

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; folderId: number | null; contents: FolderContents; crumbs: Crumb[]; warning: string | null }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'forbidden' }

type RemovedItem = { kind: 'file' | 'folder'; id: number }

export function FileBrowserPage() {
  const { folderId: folderIdParam } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const folderId = parseFolderId(folderIdParam)

  useEffect(() => {
    if (folderIdParam !== undefined && folderId === null) {
      setPage({ status: 'error', message: 'Некорректный адрес папки.' })
      return
    }

    const controller = new AbortController()
    const generation = ++requestGeneration.current
    setPage((current) => current.status === 'ready' && current.folderId === folderId ? current : { status: 'loading' })
    loadPage(folderId, location.state, controller.signal)
      .then(({ contents, crumbs }) => {
        if (generation === requestGeneration.current && !controller.signal.aborted) setPage({ status: 'ready', folderId, contents, crumbs, warning: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        if (error instanceof ApiError && error.status === 404) {
          setPage({ status: 'not-found' })
          return
        }
        if (error instanceof ApiError && error.status === 403) {
          setPage({ status: 'forbidden' })
          return
        }
        const message = safeOperationError(error, 'Не удалось загрузить папку.')
        setPage((current) => current.status === 'ready' && current.folderId === folderId ? { ...current, warning: message } : { status: 'error', message })
      })
    return () => controller.abort()
  }, [folderId, folderIdParam, location.state, reloadKey])

  const readyPage = page.status === 'ready' && page.folderId === folderId ? page : null
  const crumbs = readyPage ? readyPage.crumbs : readStateCrumbs(location.state)
  const title = crumbs[crumbs.length - 1]?.name ?? 'Мои файлы'

  function openFolder(folder: FolderItem) {
    navigate(`/files/folders/${folder.id}`, {
      state: { crumbs: [...crumbs, { id: folder.id, name: folder.name }] },
    })
  }

  function refresh(remove?: RemovedItem) {
    if (remove) {
      setPage((current) => current.status !== 'ready' || current.folderId !== folderId ? current : {
        ...current,
        contents: {
          files: remove.kind === 'file' ? current.contents.files.filter((item) => item.id !== remove.id) : current.contents.files,
          folders: remove.kind === 'folder' ? current.contents.folders.filter((item) => item.id !== remove.id) : current.contents.folders,
        },
      })
    }
    setReloadKey((key) => key + 1)
  }

  return (
    <section aria-labelledby="files-heading" className="files-page">
      <Breadcrumbs crumbs={crumbs} />
      <div className="page-heading"><div><p className="eyebrow">ВАШЕ ЛИЧНОЕ ПРОСТРАНСТВО</p><h2 id="files-heading">{title}</h2><p className="muted">Файлы и папки, которые всегда под рукой.</p></div></div>
      {folderIdParam === undefined || folderId !== null ? (
        <div className="files-toolbar">
          <UploadControl
            enabled={readyPage !== null}
            key={folderId === null ? 'upload-root' : `upload-${folderId}`}
            onUploaded={() => setReloadKey((key) => key + 1)}
            parentId={folderId ?? undefined}
          />
          <CreateFolderControl key={`create-${folderId}`} enabled={readyPage !== null} onCreated={() => setReloadKey((key) => key + 1)} parentId={folderId ?? undefined} />
        </div>
      ) : null}
      {page.status === 'loading' ? (
        <div aria-live="polite" className="directory-loading" role="status"><p className="sr-only">Загрузка файлов…</p>{[1, 2, 3, 4].map((row) => <div aria-hidden="true" className="skeleton-row" key={row}><span className="skeleton-icon" /><span className="skeleton-line" /><span className="skeleton-line skeleton-short" /></div>)}</div>
      ) : null}
      {page.status === 'error' ? (
        <div className="inline-alert directory-error" role="alert">
          <p className="error-text">{page.message}</p>
          <div className="state-actions">
            <button className="text-link" onClick={() => setReloadKey((key) => key + 1)} type="button">Повторить</button>
            <Link className="text-link" to="/files">К моим файлам</Link>
          </div>
        </div>
      ) : null}
      {page.status === 'not-found' ? (
        <DirectoryAccessState message="Папка не существует или недоступна." />
      ) : null}
      {page.status === 'forbidden' ? (
        <DirectoryAccessState message="У вас нет доступа к этой папке." />
      ) : null}
      {readyPage ? (
        <>{readyPage.warning ? <div className="inline-alert" role="alert">{readyPage.warning} <button className="text-link" onClick={() => setReloadKey((key) => key + 1)} type="button">Повторить</button></div> : null}<DirectoryTable key={`directory-${folderId}`} contents={readyPage.contents} currentFolderId={readyPage.folderId} onChanged={refresh} onOpenFolder={openFolder} /></>
      ) : null}
    </section>
  )
}

function DirectoryAccessState({ message }: { message: string }) {
  return (
    <div className="empty-state" role="alert">
      <p className="muted">{message}</p>
      <Link className="text-link" to="/files">К моим файлам</Link>
    </div>
  )
}

async function loadPage(
  folderId: number | null,
  locationState: unknown,
  signal: AbortSignal,
) {
  if (folderId === null) {
    return { contents: await getFolderContents(undefined, signal), crumbs: [] }
  }
  const stateCrumbs = readStateCrumbs(locationState)
  let crumbs: Crumb[]
  if (stateCrumbs[stateCrumbs.length - 1]?.id === folderId) {
    const folder = await getFolder(folderId, signal)
    crumbs = [
      ...stateCrumbs.slice(0, -1),
      { id: folder.id, name: folder.name },
    ]
  } else {
    crumbs = await loadAncestors(folderId, signal)
  }
  return { contents: await getFolderContents(folderId, signal), crumbs }
}

async function loadAncestors(folderId: number, signal: AbortSignal): Promise<Crumb[]> {
  const reversed: Crumb[] = []
  const visited = new Set<number>()
  let currentId: number | null = folderId
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error('Folder ancestry contains a cycle')
    visited.add(currentId)
    const folder = await getFolder(currentId, signal)
    reversed.push({ id: folder.id, name: folder.name })
    currentId = folder.parentId
  }
  return reversed.reverse()
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Путь к папке" className="breadcrumbs">
      <ol className="breadcrumb-list">
        <li>{crumbs.length === 0 ? <span aria-current="page">Мои файлы</span> : <Link className="text-link" to="/files">Мои файлы</Link>}</li>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1
          return (
            <li className="breadcrumb-item" key={crumb.id}>
              <span aria-hidden="true">/</span>
              {current ? <span aria-current="page">{crumb.name}</span> : (
                <Link className="text-link" state={{ crumbs: crumbs.slice(0, index + 1) }} to={`/files/folders/${crumb.id}`}>{crumb.name}</Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

type ItemAction = { kind: 'file' | 'folder'; item: FileItem | FolderItem; action: 'rename' | 'move' | 'copy' | 'trash' }

function DirectoryTable({ contents, currentFolderId, onChanged, onOpenFolder }: { contents: FolderContents; currentFolderId: number | null; onChanged(remove?: RemovedItem): void; onOpenFolder(folder: FolderItem): void }) {
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [action, setAction] = useState<ItemAction | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function openAction(next: ItemAction) { setError(null); setAction(next) }

  async function mutate(name: string, destination: string) {
    if (!action || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const { kind, item, action: operation } = action
    const parent = destination === '' ? undefined : Number(destination)
    try {
      if (operation === 'rename') await (kind === 'file' ? renameFile(item.id, name) : renameFolder(item.id, name))
      if (operation === 'move') await (kind === 'file' ? moveFile(item.id, parent) : moveFolder(item.id, parent ?? null))
      if (operation === 'copy') await copyFile(item.id, parent)
      if (operation === 'trash') await moveToTrash(kind, item.id)
      if (!mounted.current) return
      setAction(null)
      onChanged(operation === 'trash' ? { kind, id: item.id } : undefined)
    } catch (caught) {
      if (mounted.current) setError(safeOperationError(caught, 'Не удалось выполнить действие.'))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
  }

  const empty = contents.folders.length === 0 && contents.files.length === 0
  return (
    <div>
      <div className="directory-toolbar"><p className="muted">Папок: {contents.folders.length} · Файлов: {contents.files.length}</p><div className="view-switch" aria-label="Вид файлов"><button aria-label="Список" aria-pressed={view === 'list'} className={view === 'list' ? 'icon-button is-active' : 'icon-button'} onClick={() => setView('list')} type="button"><Icon name="list" /></button><button aria-label="Плитка" aria-pressed={view === 'grid'} className={view === 'grid' ? 'icon-button is-active' : 'icon-button'} onClick={() => setView('grid')} type="button"><Icon name="grid" /></button></div></div>
      {empty ? <div className="empty-state"><Icon name="folder" /><h3>В этой папке пока пусто</h3><p>Загрузите первый файл или создайте папку.</p></div> : (
        <table className={view === 'grid' ? 'directory-list directory-grid' : 'directory-list'}>
          <caption className="sr-only">Файлы и папки в текущем расположении</caption>
          <thead className="directory-header"><tr><th scope="col">Название</th><th scope="col">Тип</th><th scope="col">Размер</th><th scope="col">Изменено</th><th scope="col"><span className="sr-only">Действия</span></th></tr></thead>
          <tbody>
            {contents.folders.map((folder) => <tr className="directory-row" key={`folder-${folder.id}`}>
              <td className="file-name-cell"><span className="file-icon file-icon-folder"><Icon name="folder" /></span><button className="file-name" onClick={() => onOpenFolder(folder)} type="button">{folder.name}</button></td>
              <td className="file-meta"><span className="mobile-label">Тип: </span>Папка</td><td className="file-meta"><span className="mobile-label">Размер: </span>—</td><td className="file-meta"><span className="mobile-label">Изменено: </span>{formatDate(folder.updatedAt)}</td>
              <td className="file-actions"><ActionMenu label={`Действия: ${folder.name}`} disabled={pending} items={[
                { label: 'Открыть', icon: 'folder', onSelect: () => onOpenFolder(folder) },
                { label: 'Поделиться', icon: 'link', onSelect: () => setShareTarget({ fileId: folder.shareFileId, name: folder.name, isFolder: true }) },
                { label: 'Переименовать', icon: 'edit', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'rename' }) },
                { label: 'Переместить', icon: 'move', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'move' }) },
                { label: 'В корзину', icon: 'trash', danger: true, onSelect: () => openAction({ kind: 'folder', item: folder, action: 'trash' }) },
              ]} /></td>
            </tr>)}
            {contents.files.map((file) => <FileRow disabled={pending} file={file} key={`file-${file.id}`} onAction={(operation) => openAction({ kind: 'file', item: file, action: operation })} onShare={() => setShareTarget({ fileId: file.id, name: file.name, isFolder: false })} />)}
          </tbody>
        </table>
      )}
      {!action && pending ? <p className="muted" role="status">Операция продолжается…</p> : null}
      {!action && error ? <p className="inline-alert" role="alert">{error}</p> : null}
      {shareTarget ? <ShareDialog onClose={() => setShareTarget(null)} target={shareTarget} /> : null}
      {action ? <OperationDialog action={action} busy={pending} currentFolderId={currentFolderId} error={error} onClose={() => { setAction(null); setError(null) }} onSubmit={mutate} /> : null}
    </div>
  )
}

function FileRow({ disabled, file, onAction, onShare }: { disabled: boolean; file: FileItem; onAction(action: ItemAction['action']): void; onShare(): void }) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'handed-off'>('idle')
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const downloadPending = useRef(false)
  async function download() {
    if (downloadPending.current) return
    downloadPending.current = true
    setDownloadState('downloading')
    setDownloadError(null)
    try { await downloadOriginalFile(file); setDownloadState('handed-off') }
    catch (error) { setDownloadError(downloadErrorMessage(error)); setDownloadState('idle') }
    finally { downloadPending.current = false }
  }
  const fileType = file.mimeType?.startsWith('image/') ? 'image' : file.mimeType?.startsWith('text/') ? 'text' : 'file'
  return <tr className="directory-row">
    <td className="file-name-cell"><span className={`file-icon file-icon-${fileType}`}><Icon name={fileType} /></span><button className="file-name" onClick={(event) => { event.currentTarget.focus(); setShowPreview(true) }} title={file.name} type="button">{file.name}</button></td>
    <td className="file-meta"><span className="mobile-label">Тип: </span>{fileType === 'image' ? 'Изображение' : fileType === 'text' ? 'Текстовый документ' : file.mimeType === 'application/pdf' ? 'Документ PDF' : 'Файл'}</td>
    <td className="file-meta"><span className="mobile-label">Размер: </span>{formatBytes(file.size)}</td>
    <td className="file-meta"><span className="mobile-label">Изменено: </span>{formatDate(file.updatedAt)}</td>
    <td className="file-actions"><ActionMenu label={`Действия: ${file.name}`} disabled={disabled} items={[
      { label: 'Просмотр', icon: 'file', onSelect: () => setShowPreview(true) },
      { label: downloadState === 'downloading' ? 'Подготавливаем…' : 'Скачать', icon: 'download', disabled: downloadState === 'downloading', onSelect: () => void download() },
      { label: 'Поделиться', icon: 'link', onSelect: onShare },
      { label: 'Переименовать', icon: 'edit', onSelect: () => onAction('rename') },
      { label: 'Переместить', icon: 'move', onSelect: () => onAction('move') },
      { label: 'Копировать', icon: 'copy', onSelect: () => onAction('copy') },
      { label: 'В корзину', icon: 'trash', danger: true, onSelect: () => onAction('trash') },
    ]} />
    {downloadState === 'handed-off' ? <p className="upload-details muted" role="status">Скачивание передано браузеру. Состояние смотрите в его загрузках.</p> : null}
    {downloadError ? <p className="inline-alert" role="alert">{downloadError}</p> : null}
    {showPreview ? <PreviewModal file={file} onClose={() => setShowPreview(false)} /> : null}</td>
  </tr>
}

function SmallDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useDialogFocus(onClose)
  return <div className="dialog-overlay"><div aria-labelledby="file-operation-title" aria-modal="true" className="dialog-surface" ref={ref} role="dialog" tabIndex={-1}><div className="dialog-header"><h3 id="file-operation-title">{title}</h3><button aria-label="Закрыть" className="icon-button" onClick={onClose} type="button"><Icon name="close" /></button></div>{children}</div></div>
}

function OperationDialog({ action, busy, currentFolderId, error, onClose, onSubmit }: { action: ItemAction; busy: boolean; currentFolderId: number | null; error: string | null; onClose(): void; onSubmit(name: string, destination: string): Promise<void> }) {
  const [name, setName] = useState(action.item.name)
  const [destination, setDestination] = useState(action.action === 'copy' ? String(currentFolderId ?? '') : '')
  const [validation, setValidation] = useState<string | null>(null)
  const [destinations, setDestinations] = useState<Array<{ id: number; name: string }>>([])
  const [destinationLoading, setDestinationLoading] = useState(true)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [destinationReload, setDestinationReload] = useState(0)
  useEffect(() => {
    if (action.action !== 'move' && action.action !== 'copy') return
    const controller = new AbortController()
    setDestinationLoading(true)
    setDestinationError(null)
    async function load() {
      const options: Array<{ id: number; name: string }> = []
      const visited = new Set<number>()
      async function walk(parentId?: number, prefix = '') {
        const folders = await apiRequest<FolderItem[]>({ method: 'GET', url: '/files/folders', params: parentId === undefined ? undefined : { parentId }, signal: controller.signal })
        for (const folder of folders) {
          if (visited.has(folder.id)) continue
          visited.add(folder.id)
          // Do not offer the moved folder or any part of its subtree.
          if (action.kind === 'folder' && folder.id === action.item.id) continue
          const name = prefix ? `${prefix} / ${folder.name}` : folder.name
          options.push({ id: folder.id, name })
          await walk(folder.id, name)
        }
      }
      await walk()
      if (!controller.signal.aborted) setDestinations(options)
    }
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setDestinationError(safeOperationError(cause, 'Не удалось загрузить папки назначения.'))
    }).finally(() => { if (!controller.signal.aborted) setDestinationLoading(false) })
    return () => controller.abort()
  }, [action.action, action.kind, action.item.id, destinationReload])
  const titles = { rename: 'Переименовать', move: 'Переместить', copy: 'Копировать', trash: 'Переместить в корзину' }
  const selecting = action.action === 'move' || action.action === 'copy'
  return <SmallDialog title={titles[action.action]} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (busy || (selecting && (destinationLoading || destinationError))) return; if (action.action === 'rename' && (!name.trim() || name.trim().length > 255)) { setValidation('Введите название от 1 до 255 символов.'); return } setValidation(null); void onSubmit(name.trim(), destination) }}>
    <p className="muted dialog-item-name">{action.item.name}</p>
    {action.action === 'rename' ? <label className="field">Новое название<input className="input" disabled={busy} maxLength={255} onChange={(event) => { setName(event.target.value); setValidation(null) }} value={name} /></label> : null}
    {selecting ? <label className="field">Папка назначения<select className="input" disabled={busy || destinationLoading || destinationError !== null} onChange={(event) => setDestination(event.target.value)} value={destination}><option value="">Мои файлы</option>{destinations.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label> : null}
    {selecting && destinationLoading ? <p role="status">Загружаем папки назначения…</p> : null}
    {selecting && destinationError ? <p className="inline-alert" role="alert">{destinationError} <button className="text-link" onClick={() => setDestinationReload((value) => value + 1)} type="button">Повторить</button></p> : null}
    {action.action === 'trash' ? <p>{action.kind === 'folder' ? 'Папка и её содержимое попадут в корзину.' : 'Файл попадёт в корзину.'} Вы сможете восстановить их позже.</p> : null}
    {validation || error ? <p className="inline-alert" role="alert">{validation || error}</p> : null}
    <div className="dialog-actions"><button className="button button--ghost" onClick={onClose} type="button">{busy ? 'Закрыть' : 'Отмена'}</button><button className={action.action === 'trash' ? 'button button--danger' : 'button button--primary'} disabled={busy || (selecting && (destinationLoading || destinationError !== null))} type="submit">{busy ? 'Выполняется…' : titles[action.action]}</button></div>
  </form></SmallDialog>
}

type UploadUiState =
  | { status: 'idle' | 'selected' | 'cancelled'; progress: null; message: string | null }
  | { status: 'active'; progress: UploadProgress; message: null }
  | { status: 'success' | 'error'; progress: UploadProgress | null; message: string }

function CreateFolderControl({ enabled, parentId, onCreated }: { enabled: boolean; parentId?: number; onCreated(): void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (busyRef.current || !enabled) return
    if (!trimmed || trimmed.length > 255) { setError('Введите название от 1 до 255 символов.'); return }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try { await createFolder(trimmed, parentId); if (mounted.current) { setName(''); setOpen(false); onCreated() } }
    catch (caught) { if (mounted.current) setError(safeOperationError(caught, 'Не удалось создать папку.')) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  function close() { setOpen(false); setError(null) }
  return <><button className="button button--ghost" disabled={!enabled} aria-disabled={busy || undefined} onClick={(event) => { if (busyRef.current) return; event.currentTarget.focus(); setError(null); setOpen(true) }} type="button"><Icon name="plus" />Новая папка</button>{open ? <SmallDialog onClose={close} title="Новая папка"><form onSubmit={(event) => void submit(event)}><label className="field" htmlFor="new-folder-name">Название папки</label><input className="input" disabled={busy} id="new-folder-name" maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="Например, Документы" value={name} />{error ? <p className="inline-alert" role="alert">{error}</p> : null}<div className="dialog-actions"><button className="button button--ghost" onClick={close} type="button">{busy ? 'Закрыть' : 'Отмена'}</button><button className="button button--primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Создание…' : 'Создать папку'}</button></div></form></SmallDialog> : null}{!open && busy ? <p className="muted" role="status">Создание папки продолжается…</p> : null}{!open && error ? <p className="inline-alert" role="alert">{error}</p> : null}</>
}

function UploadControl({ enabled, parentId, onUploaded }: { enabled: boolean; parentId?: number; onUploaded(): void }) {
  const [file, setFile] = useState<File | null>(null)
  const [limits, setLimits] = useState<UploadLimits | null>(null)
  const [state, setState] = useState<UploadUiState>({ status: 'idle', progress: null, message: null })
  const controllerRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  useEffect(() => {
    setLimits(null)
    if (!file) return
    const controller = new AbortController()
    getUploadLimits(controller.signal)
      .then((result) => { if (!controller.signal.aborted) setLimits(result) })
      .catch(() => { /* The upload flow checks authoritative limits again before creating a session. */ })
    return () => controller.abort()
  }, [file])

  const active = state.status === 'active'
  const exceedsLimit = file !== null && limits !== null && file.size > limits.effectiveMaxFileBytes

  async function startUpload() {
    if (!file || active || !enabled || exceedsLimit || controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    setState({
      status: 'active',
      progress: { stage: 'preparing', bytesSent: 0, totalBytes: file.size, chunkIndex: null, totalChunks: 0, percent: 0 },
      message: null,
    })
    try {
      await uploadFile({
        file,
        parentId,
        signal: controller.signal,
        onProgress: (progress) => { if (!controller.signal.aborted && controllerRef.current === controller) setState({ status: 'active', progress, message: null }) },
      })
      if (controller.signal.aborted || controllerRef.current !== controller) return
      setState({ status: 'success', progress: null, message: `${file.name} — файл загружен.` })
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      onUploaded()
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ status: 'cancelled', progress: null, message: 'Загрузка отменена.' })
      } else {
        setState({ status: 'error', progress: null, message: uploadErrorMessage(error) })
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  function cancelUpload() {
    controllerRef.current?.abort()
    setState({ status: 'cancelled', progress: null, message: 'Загрузка отменена.' })
  }

  const stage = state.status === 'active' ? state.progress.stage : null

  return (
    <section aria-labelledby="upload-heading" className="upload-control">
      <h3 className="sr-only" id="upload-heading">Загрузка файла</h3>
      <div className="upload-picker">
        <label className={`button button--ghost upload-input-label${active || !enabled ? ' is-disabled' : ''}`}>
          <Icon name="plus" />Выбрать файл
        <input
          ref={inputRef}
          aria-label="Выбрать файл для загрузки"
          className="sr-only upload-input"
          disabled={active || !enabled}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null
            setFile(selected)
            setState({ status: selected ? 'selected' : 'idle', progress: null, message: null })
          }}
          type="file"
        /></label>
        <button className="button button--primary" disabled={!file || active || !enabled || exceedsLimit} onClick={() => void startUpload()} type="button"><Icon name="upload" />{state.status === 'error' || state.status === 'cancelled' ? 'Повторить загрузку' : 'Загрузить'}</button>
        {active ? <button className="button button--ghost" onClick={cancelUpload} type="button">Отменить загрузку</button> : null}
      </div>
      {file || state.message ? <div className="upload-manager" aria-label="Загрузки">
      {file ? <p className="upload-details muted">Выбран файл: {file.name} ({formatBytes(file.size)})</p> : null}
      {file && limits ? <p className="upload-details muted">Доступный размер файла сейчас: {formatBytes(limits.effectiveMaxFileBytes)}. Ограничения учитывают квоту и текущие загрузки.</p> : null}
      {exceedsLimit ? <p className="inline-alert" role="alert">Размер выбранного файла превышает доступный размер загрузки.</p> : null}
      {state.status === 'active' ? (
        <div className="upload-progress" aria-live="polite" role="status">
          <p className="muted">
            {stage === 'completing' ? 'Завершение загрузки…' : stage === 'preparing' ? 'Подготовка загрузки…' : `Загрузка… ${state.progress.percent}%`}
          </p>
          <progress className="upload-progress-bar" max={100} value={state.progress.percent}>{state.progress.percent}%</progress>
          <p className="upload-details muted">{formatBytes(state.progress.bytesSent)} из {formatBytes(state.progress.totalBytes)} передано</p>
        </div>
      ) : null}
      {state.message ? <p className={state.status === 'error' ? 'inline-alert' : state.status === 'success' ? 'upload-details success-text' : 'upload-details muted'} role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p> : null}
      </div> : null}
    </section>
  )
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof RangeError) return 'Выберите непустой файл допустимого размера.'
  if (!(error instanceof ApiError)) return 'Не удалось загрузить файл. Попробуйте ещё раз.'
  if (error.kind === 'rate-limit') return 'Сервер ограничил частоту загрузки. Подождите и повторите загрузку.'
  const message = error.message.toLowerCase()
  if (message.includes('quota')) return 'Недостаточно места для этого файла.'
  if (message.includes('file size') || message.includes('total upload size') || message.includes('chunk size')) return 'Размер файла превышает ограничение загрузки.'
  if (message.includes('file type')) return 'Этот тип файла не разрешён.'
  if (message.includes('session') && (message.includes('expired') || error.status === 404)) return 'Срок загрузки истёк. Начните её заново.'
  if (error.kind === 'network') return 'Соединение потеряно. Проверьте подключение и повторите попытку.'
  if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
  if (error.kind === 'server') return 'Сервер не смог загрузить файл. Попробуйте ещё раз.'
  return 'Загрузка отклонена. Проверьте файл и попробуйте ещё раз.'
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'Сервер недоступен. Не удалось начать скачивание.'
    if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
    if (error.status === 404) return 'Этот файл больше недоступен.'
  }
  return 'Не удалось скачать файл. Попробуйте ещё раз.'
}

function parseFolderId(value?: string): number | null {
  if (value === undefined) return null
  if (!/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readStateCrumbs(state: unknown): Crumb[] {
  const candidate = (state as FolderLocationState | null)?.crumbs
  if (!Array.isArray(candidate)) return []
  return candidate.filter((crumb): crumb is Crumb => Number.isSafeInteger(crumb?.id) && crumb.id > 0 && typeof crumb.name === 'string')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Неизвестно' : date.toLocaleDateString('ru-RU')
}
