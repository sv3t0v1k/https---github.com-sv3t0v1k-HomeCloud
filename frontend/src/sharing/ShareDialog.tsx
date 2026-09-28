import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../api/errors'
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

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const expiry = Number(expiresInDays)
    const limit = maxDownloads === '' ? undefined : Number(maxDownloads)
    if (!Number.isInteger(expiry) || expiry < 1 || expiry > 36500) {
      setError('Expiry must be a whole number from 1 to 36500 days.')
      return
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      setError('Download limit must be a positive whole number.')
      return
    }
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
      setNotice('Share link created.')
    } catch (cause) {
      setPassword('')
      setError(shareErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function copy(share: OwnerShare) {
    setError(null)
    try {
      await navigator.clipboard.writeText(publicShareUrl(share.token))
      setNotice('Share URL copied.')
    } catch {
      setError('The share URL could not be copied. Copy it from the field instead.')
    }
  }

  function open(share: OwnerShare) {
    window.open(publicShareUrl(share.token), '_blank', 'noopener,noreferrer')
  }

  async function revoke(share: OwnerShare) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await revokeShare(share.id)
      await refresh()
      setNotice('Share link revoked.')
    } catch (cause) {
      setError(shareErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div aria-labelledby="share-title" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div><h3 className="text-xl font-semibold" id="share-title">Share {target.name}</h3><p className="mt-1 text-sm text-gray-600">Links expire automatically and follow server download policy.</p></div>
          <button aria-label="Close sharing" className="text-gray-600 underline" disabled={busy} onClick={onClose} type="button">Close</button>
        </div>

        <form className="mt-5 grid gap-4 sm:grid-cols-3" onSubmit={(event) => void submit(event)}>
          <label className="text-sm text-gray-700">Expires in days<input className="mt-1 w-full rounded border px-3 py-2" max={36500} min={1} onChange={(event) => setExpiresInDays(event.target.value)} required type="number" value={expiresInDays} /></label>
          <label className="text-sm text-gray-700">Download limit (optional)<input className="mt-1 w-full rounded border px-3 py-2" min={1} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="Unlimited" type="number" value={maxDownloads} /></label>
          <label className="text-sm text-gray-700">Password (optional)<input autoComplete="new-password" className="mt-1 w-full rounded border px-3 py-2" maxLength={1024} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
          <button className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50 sm:col-span-3" disabled={busy} type="submit">{busy ? 'Working…' : 'Create share link'}</button>
        </form>

        {error ? <p className="mt-4 text-sm text-red-700" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 text-sm text-green-700" role="status">{notice}</p> : null}

        <section aria-labelledby="current-shares" className="mt-6">
          <h4 className="font-semibold" id="current-shares">Current links</h4>
          {loading ? <p className="mt-2 text-sm text-gray-600" role="status">Loading share links…</p> : null}
          {!loading && shares.length === 0 ? <p className="mt-2 text-sm text-gray-600">No active links for this item.</p> : null}
          <ul className="mt-3 space-y-3">
            {shares.map((share) => {
              const url = publicShareUrl(share.token)
              return <li className="rounded border p-3" key={share.id}>
                <input aria-label={`Public URL for ${target.name}`} className="w-full rounded border bg-gray-50 px-2 py-1 text-sm" readOnly value={url} />
                <p className="mt-2 text-xs text-gray-600">{shareStatus(share)} · {String(share.downloadCount)} downloads{share.maxDownloads === null ? '' : ` of ${String(share.maxDownloads)}`}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm"><button className="text-blue-700 underline" onClick={() => void copy(share)} type="button">Copy URL</button><button className="text-blue-700 underline" onClick={() => open(share)} type="button">Open</button><button className="text-red-700 underline disabled:opacity-50" disabled={busy} onClick={() => void revoke(share)} type="button">Revoke</button></div>
              </li>
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}

function shareStatus(share: OwnerShare): string {
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return 'Expired'
  if (share.maxDownloads !== null && Number(share.downloadCount) >= Number(share.maxDownloads)) return 'Download limit reached'
  return share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}` : 'Does not expire'
}

function shareErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Sharing could not be updated. Please try again.'
  const message = cause.message.toLowerCase()
  if (cause.kind === 'authentication') return 'Your session has expired. Please sign in again.'
  if (cause.kind === 'authorization') return 'You do not have permission to share this item.'
  if (cause.status === 404) return 'This item or share link is no longer available.'
  if (message.includes('maximum shareable size')) return 'This file exceeds the sharing size limit.'
  if (message.includes('type') && message.includes('sharing')) return 'This file type cannot be shared.'
  if (cause.kind === 'validation') return 'The sharing settings were rejected. Check the values and try again.'
  if (cause.kind === 'network') return 'The server is unavailable. Check your connection and try again.'
  return 'Sharing could not be updated. Please try again.'
}
