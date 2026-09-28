import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { copyFile, createFolder, getFolder, getFolderContents, moveFile, moveFolder, moveToTrash, renameFile, renameFolder } from './api'
import {
  BrowserDownloadLimitError,
  downloadOriginalFile,
  MAX_BROWSER_BLOB_DOWNLOAD_BYTES,
} from './download'
import { uploadFile, type UploadProgress } from './upload'
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
      setPage({ status: 'error', message: 'This folder address is invalid.' })
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
        const message = safeOperationError(error, 'This folder could not be loaded.')
        setPage((current) => current.status === 'ready' && current.folderId === folderId ? { ...current, warning: message } : { status: 'error', message })
      })
    return () => controller.abort()
  }, [folderId, folderIdParam, location.state, reloadKey])

  const readyPage = page.status === 'ready' && page.folderId === folderId ? page : null
  const crumbs = readyPage ? readyPage.crumbs : readStateCrumbs(location.state)
  const title = crumbs[crumbs.length - 1]?.name ?? 'My Files'

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
    <section aria-labelledby="files-heading">
      <Breadcrumbs crumbs={crumbs} />
      <h2 className="mb-6 text-2xl font-bold text-gray-900" id="files-heading">{title}</h2>
      {folderIdParam === undefined || folderId !== null ? (
        <div className="grid gap-4 md:grid-cols-2">
          <UploadControl
            enabled={readyPage !== null}
            key={folderId === null ? 'upload-root' : `upload-${folderId}`}
            onUploaded={() => setReloadKey((key) => key + 1)}
            parentId={folderId ?? undefined}
          />
          <CreateFolderControl enabled={readyPage !== null} onCreated={() => setReloadKey((key) => key + 1)} parentId={folderId ?? undefined} />
        </div>
      ) : null}
      {page.status === 'loading' ? (
        <p aria-live="polite" className="rounded-md bg-white p-6 text-gray-600" role="status">Loading files…</p>
      ) : null}
      {page.status === 'error' ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-6" role="alert">
          <p className="text-red-800">{page.message}</p>
          <div className="mt-4 flex gap-4">
            <button className="text-blue-700 underline" onClick={() => setReloadKey((key) => key + 1)} type="button">Try again</button>
            <Link className="text-blue-700 underline" to="/files">Return to My Files</Link>
          </div>
        </div>
      ) : null}
      {page.status === 'not-found' ? (
        <DirectoryAccessState message="This folder does not exist or is not available." />
      ) : null}
      {page.status === 'forbidden' ? (
        <DirectoryAccessState message="You do not have permission to view this folder." />
      ) : null}
      {readyPage ? (
        <>{readyPage.warning ? <div className="mb-4 rounded border border-red-200 bg-red-50 p-3" role="alert">{readyPage.warning} <button className="ml-2 text-blue-700 underline" onClick={() => setReloadKey((key) => key + 1)} type="button">Retry</button></div> : null}<DirectoryTable contents={readyPage.contents} currentFolderId={readyPage.folderId} onChanged={refresh} onOpenFolder={openFolder} /></>
      ) : null}
    </section>
  )
}

function DirectoryAccessState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-6" role="alert">
      <p className="text-amber-900">{message}</p>
      <Link className="mt-4 inline-block text-blue-700 underline" to="/files">Return to My Files</Link>
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
    <nav aria-label="Breadcrumb" className="mb-3 text-sm text-gray-600">
      <ol className="flex flex-wrap items-center gap-2">
        <li>{crumbs.length === 0 ? <span aria-current="page">My Files</span> : <Link className="text-blue-700 hover:underline" to="/files">My Files</Link>}</li>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1
          return (
            <li className="flex items-center gap-2" key={crumb.id}>
              <span aria-hidden="true">/</span>
              {current ? <span aria-current="page">{crumb.name}</span> : (
                <Link className="text-blue-700 hover:underline" state={{ crumbs: crumbs.slice(0, index + 1) }} to={`/files/folders/${crumb.id}`}>{crumb.name}</Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function DirectoryTable({ contents, currentFolderId, onChanged, onOpenFolder }: { contents: FolderContents; currentFolderId: number | null; onChanged(remove?: RemovedItem): void; onOpenFolder(folder: FolderItem): void }) {
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({})
  const pendingRef = useRef(false)
  async function mutate(key: string, operation: () => Promise<unknown>, remove?: RemovedItem) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(key)
    setError(null)
    try { await operation(); onChanged(remove) }
    catch (caught) { setError(safeOperationError(caught, 'The operation could not be completed.')) }
    finally { pendingRef.current = false; setPending(null) }
  }
  function requestedName(current: string) {
    const value = window.prompt('New name', current)?.trim()
    if (!value || value.length > 255) { if (value !== undefined) setError('Enter a valid non-empty name of at most 255 characters.'); return null }
    return value
  }
  function selectedParent(key: string): number | undefined { const value = moveTargets[key] ?? ''; return value === '' ? undefined : Number(value) }
  if (contents.folders.length === 0 && contents.files.length === 0) {
    return <p className="rounded-md bg-white p-8 text-center text-gray-600">This folder is empty.</p>
  }
  return (
    <div>{error ? <p className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-red-800" role="alert">{error}</p> : null}<div className="overflow-x-auto rounded-lg border bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <caption className="sr-only">Files and folders in the current location</caption>
        <thead className="bg-gray-50 text-left text-sm text-gray-600"><tr><th className="px-4 py-3 font-medium" scope="col">Name</th><th className="px-4 py-3 font-medium" scope="col">Type</th><th className="px-4 py-3 font-medium" scope="col">Size</th><th className="px-4 py-3 font-medium" scope="col">Modified</th><th className="px-4 py-3 text-right font-medium" scope="col">Actions</th></tr></thead>
        <tbody className="divide-y divide-gray-100">
          {contents.folders.map((folder) => (
            <tr key={`folder-${folder.id}`}><td className="px-4 py-3"><button className="font-medium text-blue-700 hover:underline" onClick={() => onOpenFolder(folder)} type="button">{folder.name}</button></td><td className="px-4 py-3 text-gray-600">Folder</td><td className="px-4 py-3 text-gray-500">—</td><td className="px-4 py-3 text-gray-600">{formatDate(folder.updatedAt)}</td><td className="px-4 py-3 text-right"><div className="flex flex-wrap justify-end gap-3"><button className="text-blue-700 hover:underline" disabled={pending !== null} onClick={() => setShareTarget({ fileId: folder.shareFileId, name: folder.name, isFolder: true })} type="button">Share {folder.name}</button><button className="text-blue-700 underline" disabled={pending !== null} onClick={() => { const name = requestedName(folder.name); if (name) void mutate(`rename-folder-${folder.id}`, () => renameFolder(folder.id, name)) }} type="button">Rename {folder.name}</button><select aria-label={`Destination for ${folder.name}`} className="rounded border px-2" disabled={pending !== null} onChange={(event) => setMoveTargets((targets) => ({ ...targets, [`folder-${folder.id}`]: event.target.value }))} value={moveTargets[`folder-${folder.id}`] ?? ''}><option value="">My Files</option>{contents.folders.filter((candidate) => candidate.id !== folder.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><button className="text-blue-700 underline" disabled={pending !== null} onClick={() => void mutate(`move-folder-${folder.id}`, () => moveFolder(folder.id, selectedParent(`folder-${folder.id}`) ?? null))} type="button">Move {folder.name}</button><button className="text-red-700 underline" disabled={pending !== null} onClick={() => { if (window.confirm(`Move ${folder.name} and its contents to Trash?`)) void mutate(`trash-folder-${folder.id}`, () => moveToTrash('folder', folder.id), { kind: 'folder', id: folder.id }) }} type="button">{pending === `trash-folder-${folder.id}` ? 'Moving…' : `Trash ${folder.name}`}</button></div></td></tr>
          ))}
          {contents.files.map((file) => <FileRow currentFolderId={currentFolderId} destinations={contents.folders} disabled={pending !== null} file={file} key={`file-${file.id}`} mutate={mutate} onShare={() => setShareTarget({ fileId: file.id, name: file.name, isFolder: false })} requestedName={requestedName} />)}
        </tbody>
      </table>
      {shareTarget ? <ShareDialog onClose={() => setShareTarget(null)} target={shareTarget} /> : null}
    </div></div>
  )
}

function FileRow({ currentFolderId, destinations, disabled, file, mutate, onShare, requestedName }: { currentFolderId: number | null; destinations: FolderItem[]; disabled: boolean; file: FileItem; mutate(key: string, operation: () => Promise<unknown>, remove?: RemovedItem): Promise<void>; onShare(): void; requestedName(current: string): string | null }) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading'>('idle')
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [moveTarget, setMoveTarget] = useState('')

  async function download() {
    if (downloadState === 'downloading') return
    setDownloadState('downloading')
    setDownloadError(null)
    try {
      await downloadOriginalFile(file)
    } catch (error) {
      setDownloadError(downloadErrorMessage(error))
    } finally {
      setDownloadState('idle')
    }
  }

  return (
    <tr>
      <td className="px-4 py-3 font-medium text-gray-900" title={file.name}>{file.name}</td>
      <td className="px-4 py-3 text-gray-600">{file.mimeType || 'File'}</td>
      <td className="px-4 py-3 text-gray-600">{formatBytes(file.size)}</td>
      <td className="px-4 py-3 text-gray-600">{formatDate(file.updatedAt)}</td>
      <td className="px-4 py-3 text-right">
        <button className="mr-3 text-blue-700 hover:underline" disabled={disabled} onClick={onShare} type="button">Share {file.name}</button>
        <button className="mr-4 text-blue-700 hover:underline" onClick={() => setShowPreview(true)} type="button">
          Preview {file.name}
        </button>
        <button className="text-blue-700 hover:underline disabled:opacity-60" disabled={downloadState === 'downloading'} onClick={() => void download()} type="button">
          {downloadState === 'downloading' ? 'Downloading…' : `Download ${file.name}`}
        </button>
        <div className="mt-2 flex flex-wrap justify-end gap-3"><button className="text-blue-700 underline" disabled={disabled} onClick={() => { const name = requestedName(file.name); if (name) void mutate(`rename-file-${file.id}`, () => renameFile(file.id, name)) }} type="button">Rename {file.name}</button><select aria-label={`Destination for ${file.name}`} className="rounded border px-2" disabled={disabled} onChange={(event) => setMoveTarget(event.target.value)} value={moveTarget}><option value="">My Files</option>{destinations.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button className="text-blue-700 underline" disabled={disabled} onClick={() => void mutate(`move-file-${file.id}`, () => moveFile(file.id, moveTarget === '' ? undefined : Number(moveTarget)))} type="button">Move {file.name}</button><button className="text-blue-700 underline" disabled={disabled} onClick={() => void mutate(`copy-file-${file.id}`, () => copyFile(file.id, currentFolderId ?? undefined))} type="button">Copy {file.name}</button><button className="text-red-700 underline" disabled={disabled} onClick={() => { if (window.confirm(`Move ${file.name} to Trash?`)) void mutate(`trash-file-${file.id}`, () => moveToTrash('file', file.id), { kind: 'file', id: file.id }) }} type="button">Trash {file.name}</button></div>
        {downloadError ? <p className="mt-1 text-sm text-red-700" role="alert">{downloadError}</p> : null}
        {showPreview ? <PreviewModal file={file} onClose={() => setShowPreview(false)} /> : null}
      </td>
    </tr>
  )
}

type UploadUiState =
  | { status: 'idle' | 'selected' | 'cancelled'; progress: null; message: string | null }
  | { status: 'active'; progress: UploadProgress; message: null }
  | { status: 'success' | 'error'; progress: UploadProgress | null; message: string }

function CreateFolderControl({ enabled, parentId, onCreated }: { enabled: boolean; parentId?: number; onCreated(): void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (busyRef.current || !enabled) return
    if (!trimmed || trimmed.length > 255) { setError('Enter a valid non-empty name of at most 255 characters.'); return }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try { await createFolder(trimmed, parentId); setName(''); onCreated() }
    catch (caught) { setError(safeOperationError(caught, 'The folder could not be created.')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <section aria-labelledby="create-folder-heading" className="mb-6 rounded-lg border bg-white p-4"><h3 className="font-semibold" id="create-folder-heading">Create a folder</h3><form className="mt-3 flex flex-wrap gap-3" onSubmit={(event) => void submit(event)}><label className="sr-only" htmlFor="new-folder-name">Folder name</label><input className="min-w-0 flex-1 rounded border px-3 py-2" disabled={!enabled || busy} id="new-folder-name" maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="Folder name" value={name} /><button className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50" disabled={!enabled || busy || !name.trim()} type="submit">{busy ? 'Creating…' : 'Create folder'}</button></form>{error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}</section>
}

function UploadControl({ enabled, parentId, onUploaded }: { enabled: boolean; parentId?: number; onUploaded(): void }) {
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<UploadUiState>({ status: 'idle', progress: null, message: null })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const active = state.status === 'active'

  async function startUpload() {
    if (!file || active || !enabled) return
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
        onProgress: (progress) => setState({ status: 'active', progress, message: null }),
      })
      setState({ status: 'success', progress: null, message: `${file.name} uploaded successfully.` })
      setFile(null)
      onUploaded()
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ status: 'cancelled', progress: null, message: 'Upload cancelled.' })
      } else {
        setState({ status: 'error', progress: null, message: uploadErrorMessage(error) })
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  function cancelUpload() {
    controllerRef.current?.abort()
    setState({ status: 'cancelled', progress: null, message: 'Upload cancelled.' })
  }

  const stage = state.status === 'active' ? state.progress.stage : null

  return (
    <section aria-labelledby="upload-heading" className="mb-6 rounded-lg border bg-white p-4">
      <h3 className="font-semibold text-gray-900" id="upload-heading">Upload a file</h3>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          aria-label="Choose a file to upload"
          disabled={active || !enabled}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null
            setFile(selected)
            setState({ status: selected ? 'selected' : 'idle', progress: null, message: null })
          }}
          type="file"
        />
        <button className="rounded bg-blue-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!file || active || !enabled} onClick={() => void startUpload()} type="button">Upload</button>
        {active ? <button className="rounded border border-gray-300 px-4 py-2 text-gray-800" onClick={cancelUpload} type="button">Cancel upload</button> : null}
      </div>
      {file ? <p className="mt-2 text-sm text-gray-600">Selected: {file.name} ({formatBytes(file.size)})</p> : null}
      {state.status === 'active' ? (
        <div className="mt-3" aria-live="polite" role="status">
          <p className="text-sm text-gray-700">
            {stage === 'completing' ? 'Finalizing upload…' : stage === 'preparing' ? 'Preparing upload…' : `Uploading… ${state.progress.percent}%`}
          </p>
          <progress className="mt-1 w-full" max={100} value={state.progress.percent}>{state.progress.percent}%</progress>
          <p className="text-xs text-gray-500">{formatBytes(state.progress.bytesSent)} of {formatBytes(state.progress.totalBytes)} transferred</p>
        </div>
      ) : null}
      {state.message ? <p className={`mt-3 text-sm ${state.status === 'error' ? 'text-red-700' : state.status === 'success' ? 'text-green-700' : 'text-gray-700'}`} role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p> : null}
    </section>
  )
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof RangeError) return 'Choose a non-empty file with a supported size.'
  if (!(error instanceof ApiError)) return 'The upload could not be completed. Please try again.'
  const message = error.message.toLowerCase()
  if (message.includes('quota')) return 'There is not enough storage space for this file.'
  if (message.includes('file size') || message.includes('total upload size') || message.includes('chunk size')) return 'This file exceeds the upload limit.'
  if (message.includes('file type')) return 'This file type is not allowed.'
  if (message.includes('session') && (message.includes('expired') || error.status === 404)) return 'The upload session expired. Start the upload again.'
  if (error.kind === 'network') return 'The network connection was lost. Check your connection and try again.'
  if (error.kind === 'authentication') return 'Your session has expired. Please sign in again.'
  if (error.kind === 'server') return 'The server could not complete the upload. Please try again.'
  return 'The upload was rejected. Check the file and try again.'
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof BrowserDownloadLimitError) {
    return `Browser download is currently limited to ${formatBytes(MAX_BROWSER_BLOB_DOWNLOAD_BYTES)} per file.`
  }
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'The download could not start because the server is unavailable.'
    if (error.kind === 'authentication') return 'Your session has expired. Please sign in again.'
    if (error.status === 404) return 'This file is no longer available.'
  }
  return 'The download could not be completed. Please try again.'
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

function formatBytes(value: string | number): string {
  const bytes = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = -1
  do { size /= 1024; unit += 1 } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString()
}
