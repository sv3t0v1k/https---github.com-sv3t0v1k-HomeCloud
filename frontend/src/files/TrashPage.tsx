import { useEffect, useRef, useState } from 'react'
import type { TrashContents } from '../types/files'
import { emptyTrash, getTrash, permanentlyDelete, restoreTrashItem } from './api'
import { safeOperationError } from './operationErrors'

type State =
  | { status: 'loading' }
  | { status: 'ready'; contents: TrashContents; warning: string | null }
  | { status: 'error'; message: string }

export function TrashPage() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const generation = useRef(0)
  const pendingRef = useRef<string | null>(null)

  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    getTrash(controller.signal).then((contents) => {
      if (current === generation.current && !controller.signal.aborted) setState({ status: 'ready', contents, warning: null })
    }).catch((error: unknown) => {
      if (current !== generation.current || controller.signal.aborted) return
      const message = safeOperationError(error, 'Trash could not be loaded.')
      setState((previous) => previous.status === 'ready' ? { ...previous, warning: message } : { status: 'error', message })
    })
    return () => controller.abort()
  }, [reloadKey])

  async function mutate(key: string, operation: () => Promise<unknown>, remove?: { kind: 'file' | 'folder'; id: number }) {
    if (pendingRef.current) return
    pendingRef.current = key
    setPending(key)
    try {
      await operation()
      if (remove) {
        setState((previous) => previous.status !== 'ready' ? previous : {
          ...previous,
          warning: null,
          contents: {
            files: remove.kind === 'file' ? previous.contents.files.filter((item) => item.id !== remove.id) : previous.contents.files,
            folders: remove.kind === 'folder' ? previous.contents.folders.filter((item) => item.id !== remove.id) : previous.contents.folders,
          },
        })
      }
      generation.current += 1
      setReloadKey((value) => value + 1)
    } catch (error) {
      setState((previous) => previous.status === 'ready' ? { ...previous, warning: safeOperationError(error, 'The operation could not be completed.') } : previous)
    } finally {
      pendingRef.current = null
      setPending(null)
    }
  }

  if (state.status === 'loading') return <p aria-live="polite" role="status">Loading trash…</p>
  if (state.status === 'error') return <div role="alert"><p>{state.message}</p><button className="text-blue-700 underline" onClick={() => setReloadKey((value) => value + 1)} type="button">Try again</button></div>

  const items = [
    ...state.contents.folders.map((item) => ({ ...item, kind: 'folder' as const })),
    ...state.contents.files.map((item) => ({ ...item, kind: 'file' as const })),
  ]
  return (
    <section aria-labelledby="trash-heading">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-gray-900" id="trash-heading">Trash</h2>
        <button className="rounded border border-red-700 px-4 py-2 text-red-700 disabled:opacity-50" disabled={items.length === 0 || pending !== null} onClick={() => {
          if (window.confirm('Permanently delete everything in Trash? This cannot be undone.')) void mutate('empty', emptyTrash)
        }} type="button">{pending === 'empty' ? 'Emptying…' : 'Empty Trash'}</button>
      </div>
      {state.warning ? <div className="mb-4 rounded border border-red-200 bg-red-50 p-3" role="alert">{state.warning} <button className="ml-2 text-blue-700 underline" onClick={() => setReloadKey((value) => value + 1)} type="button">Retry</button></div> : null}
      {items.length === 0 ? <p className="rounded-md bg-white p-8 text-center text-gray-600">Trash is empty.</p> : (
        <div className="overflow-x-auto rounded-lg border bg-white"><table className="min-w-full divide-y divide-gray-200">
          <thead><tr><th className="px-4 py-3 text-left">Name</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Deleted</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
          <tbody className="divide-y">{items.map((item) => {
            const key = `${item.kind}:${item.id}`
            return <tr key={key}><td className="px-4 py-3">{item.name}</td><td className="px-4 py-3">{item.kind === 'folder' ? 'Folder' : 'File'}</td><td className="px-4 py-3">{item.deletedAt ? new Date(item.deletedAt).toLocaleString() : 'Unknown'}</td><td className="px-4 py-3 text-right">
              <button className="mr-4 text-blue-700 underline disabled:opacity-50" disabled={pending !== null} onClick={() => void mutate(`restore:${key}`, () => restoreTrashItem(item.kind, item.id), { kind: item.kind, id: item.id })} type="button">Restore {item.name}</button>
              <button className="text-red-700 underline disabled:opacity-50" disabled={pending !== null} onClick={() => {
                if (window.confirm(`Permanently delete ${item.name}? This cannot be undone.`)) void mutate(`delete:${key}`, () => permanentlyDelete(item.kind, item.id), { kind: item.kind, id: item.id })
              }} type="button">{pending === `delete:${key}` ? 'Deleting…' : `Delete ${item.name} permanently`}</button>
            </td></tr>
          })}</tbody>
        </table></div>
      )}
    </section>
  )
}
