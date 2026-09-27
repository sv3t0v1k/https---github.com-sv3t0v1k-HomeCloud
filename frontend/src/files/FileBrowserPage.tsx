import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../api/errors'
import type { FileItem, FolderContents, FolderItem } from '../types/files'
import { getFolder, getFolderContents } from './api'

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
  if (contents.folders.length === 0 && contents.files.length === 0) {
    return <p className="rounded-md bg-white p-8 text-center text-gray-600">This folder is empty.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <caption className="sr-only">Files and folders in the current location</caption>
        <thead className="bg-gray-50 text-left text-sm text-gray-600"><tr><th className="px-4 py-3 font-medium" scope="col">Name</th><th className="px-4 py-3 font-medium" scope="col">Type</th><th className="px-4 py-3 font-medium" scope="col">Size</th><th className="px-4 py-3 font-medium" scope="col">Modified</th></tr></thead>
        <tbody className="divide-y divide-gray-100">
          {contents.folders.map((folder) => (
            <tr key={`folder-${folder.id}`}><td className="px-4 py-3"><button className="font-medium text-blue-700 hover:underline" onClick={() => onOpenFolder(folder)} type="button">{folder.name}</button></td><td className="px-4 py-3 text-gray-600">Folder</td><td className="px-4 py-3 text-gray-500">—</td><td className="px-4 py-3 text-gray-600">{formatDate(folder.updatedAt)}</td></tr>
          ))}
          {contents.files.map((file) => <FileRow file={file} key={`file-${file.id}`} />)}
        </tbody>
      </table>
    </div>
  )
}

function FileRow({ file }: { file: FileItem }) {
  return <tr><td className="px-4 py-3 font-medium text-gray-900" title={file.name}>{file.name}</td><td className="px-4 py-3 text-gray-600">{file.mimeType || 'File'}</td><td className="px-4 py-3 text-gray-600">{formatBytes(file.size)}</td><td className="px-4 py-3 text-gray-600">{formatDate(file.updatedAt)}</td></tr>
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
