import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { getFolder, getFolderContents } from './api'
import {
  BrowserDownloadLimitError,
  downloadOriginalFile,
  MAX_BROWSER_BLOB_DOWNLOAD_BYTES,
} from './download'
import { uploadFile, type UploadProgress } from './upload'
import { ShareDialog } from '../sharing/ShareDialog'
import type { ShareTarget } from '../sharing/api'
import { PreviewModal } from './PreviewModal'

interface Crumb { id: number; name: string }
interface FolderLocationState { crumbs?: Crumb[] }

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; contents: FolderContents; crumbs: Crumb[] }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'forbidden' }

export function FileBrowserPage() {
  const { folderId: folderIdParam } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const folderId = parseFolderId(folderIdParam)

  useEffect(() => {
    if (folderIdParam !== undefined && folderId === null) {
      setPage({ status: 'error', message: 'This folder address is invalid.' })
      return
    }

    const controller = new AbortController()
    setPage({ status: 'loading' })
    loadPage(folderId, location.state, controller.signal)
      .then(({ contents, crumbs }) => setPage({ status: 'ready', contents, crumbs }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 404) {
          setPage({ status: 'not-found' })
          return
        }
        if (error instanceof ApiError && error.status === 403) {
          setPage({ status: 'forbidden' })
          return
        }
        setPage({
          status: 'error',
          message: error instanceof ApiError ? error.message : 'This folder could not be loaded.',
        })
      })
    return () => controller.abort()
  }, [folderId, folderIdParam, location.state, reloadKey])

  const crumbs = page.status === 'ready' ? page.crumbs : readStateCrumbs(location.state)
  const title = crumbs[crumbs.length - 1]?.name ?? 'My Files'

  function openFolder(folder: FolderItem) {
    navigate(`/files/folders/${folder.id}`, {
      state: { crumbs: [...crumbs, { id: folder.id, name: folder.name }] },
    })
  }

  return (
    <section aria-labelledby="files-heading">
      <Breadcrumbs crumbs={crumbs} />
      <h2 className="mb-6 text-2xl font-bold text-gray-900" id="files-heading">{title}</h2>
      {folderIdParam === undefined || folderId !== null ? (
        <UploadControl
          enabled={page.status === 'ready'}
          key={folderId === null ? 'upload-root' : `upload-${folderId}`}
          onUploaded={() => setReloadKey((key) => key + 1)}
          parentId={folderId ?? undefined}
        />
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
      {page.status === 'ready' ? (
        <DirectoryTable contents={page.contents} onOpenFolder={openFolder} />
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

function DirectoryTable({ contents, onOpenFolder }: { contents: FolderContents; onOpenFolder(folder: FolderItem): void }) {
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  if (contents.folders.length === 0 && contents.files.length === 0) {
    return <p className="rounded-md bg-white p-8 text-center text-gray-600">This folder is empty.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <caption className="sr-only">Files and folders in the current location</caption>
        <thead className="bg-gray-50 text-left text-sm text-gray-600"><tr><th className="px-4 py-3 font-medium" scope="col">Name</th><th className="px-4 py-3 font-medium" scope="col">Type</th><th className="px-4 py-3 font-medium" scope="col">Size</th><th className="px-4 py-3 font-medium" scope="col">Modified</th><th className="px-4 py-3 text-right font-medium" scope="col">Actions</th></tr></thead>
        <tbody className="divide-y divide-gray-100">
          {contents.folders.map((folder) => (
            <tr key={`folder-${folder.id}`}><td className="px-4 py-3"><button className="font-medium text-blue-700 hover:underline" onClick={() => onOpenFolder(folder)} type="button">{folder.name}</button></td><td className="px-4 py-3 text-gray-600">Folder</td><td className="px-4 py-3 text-gray-500">—</td><td className="px-4 py-3 text-gray-600">{formatDate(folder.updatedAt)}</td><td className="px-4 py-3 text-right"><button className="text-blue-700 hover:underline" onClick={() => setShareTarget({ fileId: folder.shareFileId, name: folder.name, isFolder: true })} type="button">Share {folder.name}</button></td></tr>
          ))}
          {contents.files.map((file) => <FileRow file={file} key={`file-${file.id}`} onShare={() => setShareTarget({ fileId: file.id, name: file.name, isFolder: false })} />)}
        </tbody>
      </table>
      {shareTarget ? <ShareDialog onClose={() => setShareTarget(null)} target={shareTarget} /> : null}
    </div>
  )
}

function FileRow({ file, onShare }: { file: FileItem; onShare(): void }) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading'>('idle')
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

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
        <button className="mr-3 text-blue-700 hover:underline" onClick={onShare} type="button">Share {file.name}</button>
        <button className="mr-4 text-blue-700 hover:underline" onClick={() => setShowPreview(true)} type="button">
          Preview {file.name}
        </button>
        <button className="text-blue-700 hover:underline disabled:opacity-60" disabled={downloadState === 'downloading'} onClick={() => void download()} type="button">
          {downloadState === 'downloading' ? 'Downloading…' : `Download ${file.name}`}
        </button>
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
