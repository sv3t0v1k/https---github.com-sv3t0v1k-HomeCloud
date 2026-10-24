import { formatBytes } from '../ui/formatBytes'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { ActionMenu } from '../ui/ActionMenu'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { apiRequest } from '../api/client'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { copyFile, createFolder, getFolder, getFolderContents, moveFile, moveFolder, moveToTrash, renameFile, renameFolder } from './api'
import { downloadOriginalFile, downloadSelectionArchive, type ArchiveSelection } from './download'
import { droppedEntries, inputEntries, pickDirectory } from '../sharing/publicTree'
import { enqueueTree } from './treeUpload'
import { UploadQueue, type UploadQueueItem } from './uploadQueue'
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

export function FileBrowserPage({ revision = 0 }: { revision?: number }) {
  const { folderId: folderIdParam } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const folderId = parseFolderId(folderIdParam)
  const providedQueue = useContext(UploadQueueContext)
  const [fallbackQueue] = useState(() => new UploadQueue(0, null))
  const queue = providedQueue ?? fallbackQueue
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const alive = useRef(true)
  const [collecting, setCollecting] = useState(false)
  const collectionLock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => () => fallbackQueue.dispose(), [fallbackQueue])
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', preventNavigation)
    window.addEventListener('drop', preventNavigation)
    return () => {
      window.removeEventListener('dragover', preventNavigation)
      window.removeEventListener('drop', preventNavigation)
    }
  }, [])

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
  }, [folderId, folderIdParam, location.state, reloadKey, revision])

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
    <section aria-labelledby="files-heading" className={`files-page${dragging ? ' files-page--drop' : ''}`}
      onDragEnter={(event) => { if (!Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); dragDepth.current += 1; setDragging(true) }}
      onDragOver={(event) => { if (!Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = readyPage ? 'copy' : 'none' }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) }}
      onDrop={(event) => {
        event.preventDefault(); dragDepth.current = 0; setDragging(false)
        if (!readyPage) { setDropError('Дождитесь загрузки папки и повторите перетаскивание.'); return }
        if (collectionLock.current) { setDropError('Дождитесь добавления предыдущей папки.'); return }
        collectionLock.current = true; setCollecting(true); setDropError(null)
        const target = folderId ?? undefined
        void droppedEntries(event.dataTransfer.items ?? [] as unknown as DataTransferItemList, event.dataTransfer.files)
          .then((entries) => enqueueTree(entries, queue, target, () => alive.current, () => { if (alive.current) setReloadKey((key) => key + 1) }))
          .catch((cause: unknown) => { if (alive.current) setDropError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : 'Не удалось добавить дерево папки. Уже добавленные объекты сохранены. Проверьте папку перед повтором.') })
          .finally(() => { collectionLock.current = false; if (alive.current) setCollecting(false) })
      }}>
      {dragging ? <p className="upload-drop-status" role="status">Отпустите файлы, чтобы загрузить их в текущую папку.</p> : null}
      {dropError ? <p className="inline-alert" role="alert">{dropError}</p> : null}
      {collecting ? <p role="status">Добавляем папки и файлы…</p> : null}
      <Breadcrumbs crumbs={crumbs} />
      <div className="page-heading"><h2 id="files-heading">{title}</h2></div>
      {folderIdParam === undefined || folderId !== null ? (
        <div className="files-toolbar">
          <UploadControl
            enabled={readyPage !== null}
            queue={queue}
            onUploaded={() => setReloadKey((key) => key + 1)}
            parentId={folderId ?? undefined}
          />
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
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiveHandedOff, setArchiveHandedOff] = useState(false)
  const archivePendingRef = useRef(false)
  useEffect(() => {
    const valid = new Set([...contents.folders.map((item) => `folder:${item.id}`), ...contents.files.map((item) => `file:${item.id}`)])
    setSelection((previous) => new Set([...previous].filter((key) => valid.has(key))))
  }, [contents])
  const anchor = useRef<string>()
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const folders = contents.folders.filter((item) => matches(item.name))
  const files = contents.files.filter((item) => matches(item.name))
  const visibleKeys = [...folders.map((item) => `folder:${item.id}`), ...files.map((item) => `file:${item.id}`)]
  function select(key: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, toggle = false) {
    setSelection((previous) => {
      if (event.shiftKey && anchor.current && visibleKeys.includes(anchor.current)) {
        const indices = [visibleKeys.indexOf(anchor.current), visibleKeys.indexOf(key)].sort((a, b) => a - b)
        return new Set([...previous, ...visibleKeys.slice(indices[0], indices[1] + 1)])
      }
      anchor.current = key
      if (toggle || event.metaKey || event.ctrlKey) { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next }
      return new Set([key])
    })
  }
  function contextMenu(event: React.MouseEvent<HTMLTableRowElement>, key: string) {
    if ((event.target as HTMLElement).closest('.file-actions, input, label')) return
    event.preventDefault()
    if (!selection.has(key)) setSelection(new Set([key]))
    event.currentTarget.querySelector<HTMLButtonElement>('.action-menu > button')?.click()
  }
  async function downloadArchive() {
    if (archivePendingRef.current || selection.size < 2) return
    archivePendingRef.current = true
    setArchivePending(true)
    setArchiveError(null)
    setArchiveHandedOff(false)
    const items: ArchiveSelection[] = [...selection].map((key) => {
      const [kind, id] = key.split(':')
      return { kind: kind as ArchiveSelection['kind'], id: Number(id) }
    })
    try {
      await downloadSelectionArchive(items)
      if (mounted.current) setArchiveHandedOff(true)
    } catch (cause) {
      if (mounted.current) setArchiveError(archiveDownloadErrorMessage(cause))
    } finally {
      archivePendingRef.current = false
      if (mounted.current) setArchivePending(false)
    }
  }
  async function trashSelection() {
    if (pendingRef.current) return
    pendingRef.current = true; setPending(true); setBulkError(null)
    const targets = [...selection]
    try {
      for (const key of targets) {
        const [kind, id] = key.split(':')
        await moveToTrash(kind as 'file' | 'folder', Number(id))
        if (!mounted.current) return
        setSelection((previous) => { const next = new Set(previous); next.delete(key); return next })
        onChanged({ kind: kind as 'file' | 'folder', id: Number(id) })
      }
      setBulkOpen(false)
    } catch (cause) { if (mounted.current) setBulkError(safeOperationError(cause, 'Не удалось переместить все объекты в корзину. Уже обработанные объекты сохранены.')) }
    finally { pendingRef.current = false; if (mounted.current) setPending(false) }
  }
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

  const empty = folders.length === 0 && files.length === 0
  return (
    <div>
      <div className="directory-search"><label className="field" htmlFor="file-search">Поиск в текущей папке</label><input className="input" id="file-search" type="search" placeholder="Найти файл или папку" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      {selection.size ? <><div className="selection-toolbar" role="region" aria-label="Выделенные объекты"><span>Выбрано: {selection.size}</span><button className="button button--ghost" onClick={() => setSelection(new Set(visibleKeys))} type="button">Выбрать всё</button>{selection.size >= 2 ? <button className="button button--ghost" disabled={archivePending || pending} onClick={() => void downloadArchive()} type="button"><Icon name="download" />{archivePending ? 'Подготавливаем ZIP…' : 'Скачать ZIP'}</button> : null}<button className="button button--ghost" disabled={pending || archivePending} onClick={(event) => { event.currentTarget.focus(); setBulkError(null); setBulkOpen(true) }} type="button"><Icon name="trash" />В корзину</button><button className="button button--ghost" onClick={() => setSelection(new Set())} type="button">Снять выделение</button></div>{archiveError ? <p className="inline-alert" role="alert">{archiveError}</p> : null}{archiveHandedOff ? <p className="muted" role="status">ZIP передан браузеру. Состояние смотрите в его загрузках.</p> : null}</> : null}
      {bulkOpen ? <SmallDialog title="Переместить выбранное в корзину?" onClose={() => { if (!pending) setBulkOpen(false) }}><p>Объектов: {selection.size}. Их можно будет восстановить.</p>{bulkError ? <p role="alert">{bulkError}</p> : null}<div className="dialog-actions"><button className="button button--ghost" disabled={pending} onClick={() => setBulkOpen(false)} type="button">Отмена</button><button className="button button--danger" disabled={pending} onClick={() => void trashSelection()} type="button">{pending ? 'Выполняется…' : 'Переместить выбранное'}</button></div></SmallDialog> : null}
      <div className="directory-toolbar"><p className="muted">Папок: {contents.folders.length} · Файлов: {contents.files.length}</p><div className="view-switch" aria-label="Вид файлов"><button aria-label="Список" aria-pressed={view === 'list'} className={view === 'list' ? 'icon-button is-active' : 'icon-button'} onClick={() => setView('list')} type="button"><Icon name="list" /></button><button aria-label="Плитка" aria-pressed={view === 'grid'} className={view === 'grid' ? 'icon-button is-active' : 'icon-button'} onClick={() => setView('grid')} type="button"><Icon name="grid" /></button></div></div>
      {empty ? <div className="empty-state"><Icon name="folder" /><h3>{query ? "Ничего не найдено" : "В этой папке пока пусто"}</h3><p>{query ? "Попробуйте другое название." : "Перетащите файлы сюда или воспользуйтесь кнопкой «Добавить»."}</p></div> : (
        <table className={view === 'grid' ? 'directory-list directory-grid' : 'directory-list'}>
          <caption className="sr-only">Файлы и папки в текущем расположении</caption>
          <thead className="directory-header"><tr><th scope="col">Название</th><th scope="col">Тип</th><th scope="col">Размер</th><th scope="col">Изменено</th><th scope="col"><span className="sr-only">Действия</span></th></tr></thead>
          <tbody>
            {folders.map((folder) => <tr className={`directory-row${selection.has(`folder:${folder.id}`) ? ' is-selected' : ''}`} key={`folder-${folder.id}`} onContextMenu={(event) => contextMenu(event, `folder:${folder.id}`)} onClick={(event) => { if (!(event.target as HTMLElement).closest('.file-actions, input, label')) select(`folder:${folder.id}`, event) }}>
              <td className="file-name-cell"><label className="selection-hit"><input aria-label={`Выбрать ${folder.name}`} type="checkbox" checked={selection.has(`folder:${folder.id}`)} onChange={() => {}} onClick={(event) => select(`folder:${folder.id}`, event, true)} /></label><span className="file-icon file-icon-folder"><Icon name="folder" /></span><button className="file-name" onDoubleClick={() => onOpenFolder(folder)} onKeyDown={(event) => { if (event.key === "Enter") onOpenFolder(folder) }} type="button">{folder.name}</button></td>
              <td className="file-meta"><span className="mobile-label">Тип: </span>Папка</td><td className="file-meta"><span className="mobile-label">Размер: </span>—</td><td className="file-meta"><span className="mobile-label">Изменено: </span>{formatDate(folder.updatedAt)}</td>
              <td className="file-actions"><ActionMenu label={`Действия: ${folder.name}`} disabled={pending} items={[
                { label: 'Открыть', icon: 'folder', onSelect: () => onOpenFolder(folder) },
                { label: 'Поделиться', icon: 'link', onSelect: () => setShareTarget({ fileId: folder.shareFileId, name: folder.name, isFolder: true }) },
                { label: 'Переименовать', icon: 'edit', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'rename' }) },
                { label: 'Переместить', icon: 'move', onSelect: () => openAction({ kind: 'folder', item: folder, action: 'move' }) },
                { label: 'В корзину', icon: 'trash', danger: true, onSelect: () => openAction({ kind: 'folder', item: folder, action: 'trash' }) },
              ]} /></td>
            </tr>)}
            {files.map((file) => <FileRow selected={selection.has(`file:${file.id}`)} onSelect={(event, toggle) => select(`file:${file.id}`, event, toggle)} onContextMenu={(event) => contextMenu(event, `file:${file.id}`)} disabled={pending} file={file} key={`file-${file.id}`} onAction={(operation) => openAction({ kind: 'file', item: file, action: operation })} onShare={() => setShareTarget({ fileId: file.id, name: file.name, isFolder: false })} />)}
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

function FileRow({ disabled, file, onAction, onShare, selected, onSelect, onContextMenu }: { selected: boolean; onSelect(event: React.MouseEvent, toggle?: boolean): void; onContextMenu(event: React.MouseEvent<HTMLTableRowElement>): void; disabled: boolean; file: FileItem; onAction(action: ItemAction['action']): void; onShare(): void }) {
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
  return <tr className={`directory-row${selected ? ' is-selected' : ''}`} onContextMenu={onContextMenu} onClick={(event) => { if (!(event.target as HTMLElement).closest('.file-actions, input, label')) onSelect(event) }}>
    <td className="file-name-cell"><label className="selection-hit"><input aria-label={`Выбрать ${file.name}`} type="checkbox" checked={selected} onChange={() => {}} onClick={(event) => onSelect(event, true)} /></label><span className={`file-icon file-icon-${fileType}`}><Icon name={fileType} /></span><button className="file-name" onDoubleClick={(event) => { event.currentTarget.focus(); setShowPreview(true) }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setShowPreview(true) } }} title={file.name} type="button">{file.name}</button></td>
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

function CreateFolderControl({ enabled, parentId, onCreated, open, setOpen, onBusyChange }: { onBusyChange(value: boolean): void; enabled: boolean; parentId?: number; onCreated(): void; open: boolean; setOpen(value: boolean): void }) {
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
    onBusyChange(true)
    setBusy(true)
    setError(null)
    try { await createFolder(trimmed, parentId); if (mounted.current) { setName(''); setOpen(false); onCreated() } }
    catch (caught) { if (mounted.current) setError(safeOperationError(caught, 'Не удалось создать папку.')) }
    finally { busyRef.current = false; onBusyChange(false); if (mounted.current) setBusy(false) }
  }
  function close() { setOpen(false); setError(null) }
  return <>{open ? <SmallDialog onClose={close} title="Новая папка"><form onSubmit={(event) => void submit(event)}><label className="field" htmlFor="new-folder-name">Название папки</label><input className="input" disabled={busy} id="new-folder-name" maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="Например, Документы" value={name} />{error ? <p className="inline-alert" role="alert">{error}</p> : null}<div className="dialog-actions"><button className="button button--ghost" onClick={close} type="button">{busy ? 'Закрыть' : 'Отмена'}</button><button className="button button--primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Создание…' : 'Создать папку'}</button></div></form></SmallDialog> : null}{!open && busy ? <p className="muted" role="status">Создание папки продолжается…</p> : null}{!open && error ? <p className="inline-alert" role="alert">{error}</p> : null}</>
}

const UploadQueueContext = createContext<UploadQueue | null>(null)

export function UploadQueueProvider({ ownerId, children }: { ownerId: number; children: ReactNode }) {
  const [queue] = useState(() => new UploadQueue(ownerId))
  const [discoveryError, setDiscoveryError] = useState(false)
  useEffect(() => {
    void queue.discover().catch(() => setDiscoveryError(true))
    return () => queue.dispose()
  }, [queue])
  return <UploadQueueContext.Provider value={queue}>{discoveryError ? <p className="inline-alert" role="alert">Не удалось проверить незавершённые загрузки. <button className="text-link" onClick={() => { void queue.discover().then(() => setDiscoveryError(false)).catch(() => setDiscoveryError(true)) }} type="button">Проверить снова</button></p> : null}{children}</UploadQueueContext.Provider>
}

function UploadControl({ enabled, parentId, onUploaded, queue }: { enabled: boolean; parentId?: number; onUploaded(): void; queue: UploadQueue }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  useEffect(() => setCreateOpen(false), [parentId])
  const [collecting, setCollecting] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const busy = useRef(false)
  const alive = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const knownCompleted = useRef(new Set<string>())
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let changed = false
    for (const item of items) if (item.state === 'completed' && !knownCompleted.current.has(item.id)) { knownCompleted.current.add(item.id); changed = true }
    if (changed) onUploaded()
  }, [items, onUploaded])
  async function add(entries: Parameters<typeof enqueueTree>[0], target = parentId) {
    if (busy.current || !enabled) return
    busy.current = true; setCollecting(true); setTreeError(null); setCollapsed(false)
    try { await enqueueTree(entries, queue, target, () => alive.current, onUploaded) }
    catch (cause) { if (alive.current) setTreeError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : 'Не удалось добавить папку. Уже добавленные объекты сохранены. Проверьте результат перед повтором.') }
    finally { busy.current = false; if (alive.current) setCollecting(false) }
  }
  async function chooseFolder() {
    const target = parentId
    try {
      const entries = await pickDirectory()
      if (!alive.current) return
      if (entries) await add(entries, target)
      else folderRef.current?.click()
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') setTreeError('Не удалось прочитать папку. Повторите выбор или перетащите её в окно.')
    }
  }
  const problems = items.filter((item) => item.state === 'error' || item.needsFile).length
  const allCompleted = items.length > 0 && items.every((item) => item.state === 'completed')
  return <section aria-label="Добавление и загрузки" className="upload-control">
    <ActionMenu label="Добавить" triggerLabel="Добавить" disabled={!enabled || collecting} items={[
      { label: 'Загрузить файлы', icon: 'upload', onSelect: () => inputRef.current?.click() },
      { label: 'Загрузить папку', icon: 'folder', onSelect: () => void chooseFolder() },
      { label: 'Новая папка', icon: 'plus', disabled: createBusy, onSelect: () => setCreateOpen(true) },
    ]} />
    <input ref={inputRef} aria-label="Выбрать файл для загрузки" className="sr-only upload-input" disabled={!enabled || collecting} multiple type="file"
      onChange={(event) => { try { void add(inputEntries(event.target.files ?? [])) } catch (cause) { setTreeError(cause instanceof Error ? cause.message : 'Не удалось прочитать файлы.') } event.target.value = '' }} />
    <input ref={folderRef} aria-label="Выбрать папку для загрузки" className="sr-only upload-input" disabled={!enabled || collecting} multiple type="file" {...{ webkitdirectory: '', directory: '' }}
      onChange={(event) => { try { void add(inputEntries(event.target.files ?? [])) } catch (cause) { setTreeError(cause instanceof Error ? cause.message : 'Не удалось прочитать папку.') } event.target.value = '' }} />
    <CreateFolderControl key={`create-${parentId}`} enabled={enabled} parentId={parentId} onCreated={onUploaded} open={createOpen} setOpen={setCreateOpen} onBusyChange={setCreateBusy} />
    <p className="upload-details muted">Перетащите файлы или папки сюда — загрузка начнётся сразу.</p><details className="upload-details muted folder-picker-note"><summary>О загрузке папок</summary><p>Выбор папки через список файлов может пропустить пустые каталоги. Перетащите папку или создайте их вручную. Пустые файлы пока не поддерживаются.</p></details>
    {collecting ? <p role="status">Добавляем папки и файлы…</p> : null}
    {treeError ? <p className="inline-alert" role="alert">{treeError}</p> : null}
    {items.length ? <div className="upload-manager" aria-label="Загрузки">
      <div className="upload-manager-header"><button className="button button--ghost upload-summary" aria-expanded={!collapsed} aria-controls="upload-list" onClick={() => setCollapsed((value) => !value)} type="button"><Icon name="upload" />Загрузки · {items.filter((item) => item.state === 'completed').length}/{items.length}{problems ? ` · Требуют внимания: ${problems}` : ''}<span>{collapsed ? 'Развернуть' : 'Свернуть'}</span></button>{allCompleted ? <button className="button button--ghost upload-dismiss" onClick={() => queue.dismissCompleted()} type="button">Закрыть</button> : null}</div>
      <div id="upload-list" hidden={collapsed}>
      <ul className="upload-queue">{items.map((item) => <UploadRow key={item.id} item={item} queue={queue} />)}</ul>
      </div>
    </div> : null}
  </section>
}

const uploadStateLabels: Record<UploadQueueItem['state'], string> = {
  selected: 'Ожидает запуска', queued: 'В очереди', preparing: 'Подготовка загрузки…', hashing: 'Вычисление SHA-256…', uploading: 'Загрузка…',
  pausing: 'Приостанавливаем после текущей части…', paused: 'Приостановлено', retrying: 'Ожидание повторной попытки…',
  completing: 'Финализация файла на HDD…', completed: 'Файл загружен', error: 'Требуется действие', cancelling: 'Отменяем загрузку…',
  cancelled: 'Загрузка отменена.', 'needs-file': 'Для докачки выберите исходный файл',
}

function UploadRow({ item, queue }: { item: UploadQueueItem; queue: UploadQueue }) {
  const canPause = ['queued', 'preparing', 'hashing', 'uploading', 'retrying'].includes(item.state)
  const canResume = ['paused', 'error'].includes(item.state) && !item.needsFile
  const canCancel = !['completed', 'cancelled', 'cancelling', 'completing'].includes(item.state)
  const [reselectionError, setReselectionError] = useState<string | null>(null)
  return <li className="upload-queue-item" aria-label={`Загрузка: ${item.name}`}>
    <div className="upload-queue-title"><strong>{item.name}</strong><span className="muted" role="status">{uploadStateLabels[item.state]}</span></div>
    <progress aria-label={`Прогресс: ${item.name}`} className="upload-progress-bar" max={100} value={item.state === 'hashing' ? item.hashPercent : item.percent}>{item.state === 'hashing' ? item.hashPercent : item.percent}%</progress>
    <p className="upload-details muted">{item.state === 'hashing' ? `${item.hashPercent}% · ${formatBytes(item.hashedBytes ?? 0)} из ${formatBytes(item.size)} проверено` : `${item.percent}% · ${formatBytes(item.committedBytes)} из ${formatBytes(item.size)}`}</p>
    {item.error ? <p className="inline-alert" role="alert">{item.error}</p> : null}
    {reselectionError ? <p className="inline-alert" role="alert">{reselectionError}</p> : null}
    <div className="state-actions">
      {canPause ? <button aria-label={`Пауза: ${item.name}`} className="button button--ghost" onClick={() => queue.pause(item.id)} type="button">Пауза</button> : null}
      {canResume ? <button aria-label={`Продолжить: ${item.name}`} className="button button--ghost" onClick={() => queue.resume(item.id)} type="button">{item.state === 'error' && !item.uploadId ? 'Повторить загрузку' : 'Продолжить'}</button> : null}
      {item.needsFile ? <label className="button button--ghost">Выбрать исходный файл<input aria-label={`Исходный файл: ${item.name}`} className="sr-only upload-input" type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setReselectionError(null); void queue.reselect(item.id, file).catch((error: unknown) => setReselectionError(error instanceof Error ? error.message : 'Не удалось проверить исходный файл.')) }} /></label> : null}
      {canCancel ? <button aria-label={`Отменить загрузку: ${item.name}`} className="button button--ghost" onClick={() => queue.cancel(item.id)} type="button">Отменить загрузку</button> : null}
    </div>
  </li>
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'Сервер недоступен. Не удалось начать скачивание.'
    if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
    if (error.status === 404) return 'Этот файл больше недоступен.'
  }
  return 'Не удалось скачать файл. Попробуйте ещё раз.'
}

function archiveDownloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'Сервер недоступен. Не удалось начать скачивание ZIP.'
    if (error.kind === 'authentication') return 'Сессия истекла. Войдите снова.'
    if (error.status === 403) return 'Нет доступа к одному из выбранных объектов.'
    if (error.status === 404) return 'Один из выбранных объектов больше недоступен. Обновите список.'
    if (error.status === 409) return 'Состав архива изменился. Обновите список и попробуйте снова.'
    if (error.status === 400 || error.status === 413 || error.status === 422) return 'Выбор превышает ограничения архива или содержит недоступные объекты. Уменьшите выбор и попробуйте снова.'
    if (error.status === 429) return 'Слишком много запросов. Подождите и попробуйте снова.'
    if (error.status === 503) return 'Сервер сейчас занят. Попробуйте позже.'
  }
  return 'Не удалось подготовить ZIP. Попробуйте ещё раз.'
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
