import { useEffect, useState } from 'react'

import { ApiError } from '../api/errors'
import type { FileItem } from '../types/files'
import { getFilePreview, previewImageBlob, type PreviewPayload } from './preview'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: PreviewPayload; imageUrl?: string }
  | { status: 'error'; message: string }

export function PreviewModal({ file, onClose }: { file: FileItem; onClose(): void }) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setState({ status: 'loading' })

    getFilePreview(file.id, controller.signal)
      .then((preview) => {
        if (controller.signal.aborted) return
        if (preview.type === 'image') {
          objectUrl = URL.createObjectURL(previewImageBlob(preview))
        }
        setState({ status: 'ready', preview, imageUrl: objectUrl })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: previewErrorMessage(error) })
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.id])

  return (
    <div
      aria-labelledby="preview-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h3 className="break-all text-lg font-semibold text-gray-900" id="preview-title">Preview: {file.name}</h3>
          <button className="text-blue-700 hover:underline" onClick={onClose} type="button">Close preview</button>
        </div>
        {state.status === 'loading' ? <p className="mt-5 text-gray-600" role="status">Loading preview…</p> : null}
        {state.status === 'error' ? <p className="mt-5 rounded-md bg-red-50 p-4 text-red-800" role="alert">{state.message}</p> : null}
        {state.status === 'ready' && state.preview.type === 'text' ? (
          <pre className="mt-5 max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-950 p-4 text-sm text-gray-100">{state.preview.content}</pre>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'image' && state.imageUrl ? (
          <img alt={`Preview of ${file.name}`} className="mx-auto mt-5 max-h-[65vh] max-w-full object-contain" src={state.imageUrl} />
        ) : null}
        {state.status === 'ready' && state.preview.type === 'unsupported' ? (
          <p className="mt-5 rounded-md bg-amber-50 p-4 text-amber-900" role="status">Preview is not available for this file type.</p>
        ) : null}
      </div>
    </div>
  )
}

function previewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The preview could not be loaded. Please try again.'
  const message = error.message.toLowerCase()
  if (error.kind === 'network') return 'The preview could not be loaded because the server is unavailable.'
  if (error.kind === 'authentication') return 'Your session has expired. Please sign in again.'
  if (error.kind === 'authorization') return 'You do not have permission to preview this file.'
  if (error.status === 404) return 'This file is no longer available.'
  if (error.status === 400 && (message.includes('maximum preview size') || message.includes('exceeds'))) {
    return 'This file is too large to preview.'
  }
  if (error.status === 400) return 'This file cannot be previewed.'
  if (error.kind === 'server') return 'The server could not generate this preview. Please try again.'
  return 'The preview could not be loaded. Please try again.'
}
