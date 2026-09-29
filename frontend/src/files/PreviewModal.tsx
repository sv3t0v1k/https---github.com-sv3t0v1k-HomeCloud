import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/errors'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import type { FileItem } from '../types/files'
import { getFilePreview, previewImageBlob, type PreviewPayload } from './preview'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: PreviewPayload; imageUrl?: string }
  | { status: 'error'; message: string }

export function PreviewModal({ file, onClose }: { file: FileItem; onClose(): void }) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocus(onClose, closeButtonRef)

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
      className="dialog-overlay preview-overlay"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="dialog-surface preview-dialog">
        <div className="dialog-header">
          <h3 className="preview-title" id="preview-title">Просмотр: {file.name}</h3>
          <button className="button button--ghost" onClick={onClose} ref={closeButtonRef} type="button">Закрыть просмотр</button>
        </div>
        <div className="dialog-body preview-content">
        {state.status === 'loading' ? <p className="loading-state preview-loading" role="status">Загружаем предпросмотр…</p> : null}
        {state.status === 'error' ? <p className="alert alert--danger" role="alert">{state.message}</p> : null}
        {state.status === 'ready' && state.preview.type === 'text' ? (
          <pre className="preview-text mono">{state.preview.content}</pre>
        ) : null}
        {state.status === 'ready' && state.preview.type === 'image' && state.imageUrl ? (
          <img alt={`Предпросмотр: ${file.name}`} className="preview-image" src={state.imageUrl} />
        ) : null}
        {state.status === 'ready' && state.preview.type === 'unsupported' ? (
          <p className="empty-state preview-unsupported" role="status">Предпросмотр недоступен для этого типа файлов.</p>
        ) : null}
        </div>
      </div>
    </div>
  )
}

function previewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось загрузить предпросмотр. Попробуйте ещё раз.'
  const message = error.message.toLowerCase()
  if (error.kind === 'network') return 'Не удалось загрузить предпросмотр: сервер недоступен.'
  if (error.kind === 'authentication') return 'Сеанс завершён. Войдите снова.'
  if (error.kind === 'authorization') return 'У вас нет разрешения на просмотр этого файла.'
  if (error.status === 404) return 'Этот файл больше недоступен.'
  if (error.status === 400 && (message.includes('maximum preview size') || message.includes('exceeds'))) {
    return 'Файл слишком большой для предпросмотра.'
  }
  if (error.status === 400) return 'Предпросмотр этого файла недоступен.'
  if (error.kind === 'server') return 'Сервер не смог подготовить предпросмотр. Попробуйте ещё раз.'
  return 'Не удалось загрузить предпросмотр. Попробуйте ещё раз.'
}
