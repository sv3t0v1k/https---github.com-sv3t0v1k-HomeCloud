import { useEffect, useRef, useState } from 'react'
import { useDialogFocus } from '../accessibility/useDialogFocus'
import { Icon } from '../ui/Icon'
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
  const [confirmation, setConfirmation] = useState<{ title: string; confirmLabel: string; run(): void } | null>(null)
  const generation = useRef(0)
  const pendingRef = useRef<string | null>(null)

  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    getTrash(controller.signal).then((contents) => {
      if (current === generation.current && !controller.signal.aborted) setState({ status: 'ready', contents, warning: null })
    }).catch((error: unknown) => {
      if (current !== generation.current || controller.signal.aborted) return
      const message = safeOperationError(error, 'Не удалось загрузить корзину.')
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
      setState((previous) => previous.status === 'ready' ? { ...previous, warning: safeOperationError(error, 'Не удалось выполнить операцию.') } : previous)
    } finally {
      pendingRef.current = null
      setPending(null)
    }
  }

  if (state.status === 'loading') return <div className="loading-state" aria-live="polite" role="status"><p>Загружаем корзину…</p><div aria-hidden="true" className="skeleton-row" /><div aria-hidden="true" className="skeleton-row" /><div aria-hidden="true" className="skeleton-row" /></div>
  if (state.status === 'error') return <div className="alert alert--danger" role="alert"><p>{state.message}</p><button className="button button--ghost" onClick={() => setReloadKey((value) => value + 1)} type="button">Попробовать снова</button></div>

  const items = [
    ...state.contents.folders.map((item) => ({ ...item, kind: 'folder' as const })),
    ...state.contents.files.map((item) => ({ ...item, kind: 'file' as const })),
  ]
  return (
    <section aria-labelledby="trash-heading" className="trash-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Удалённые объекты</p>
          <h2 className="page-heading" id="trash-heading">Корзина</h2>
          <p className="page-description">Восстановите нужное или удалите навсегда. Безвозвратное удаление нельзя отменить.</p>
        </div>
        <button className="button button--danger" disabled={items.length === 0 || pending !== null} onClick={() => setConfirmation({
          title: 'Очистить корзину?',
          confirmLabel: 'Удалить всё навсегда',
          run: () => void mutate('empty', emptyTrash),
        })} type="button"><Icon name="trash" />{pending === 'empty' ? 'Очищаем…' : 'Очистить корзину'}</button>
      </header>
      {state.warning ? <div className="alert alert--danger" role="alert">{state.warning} <button className="button button--ghost" onClick={() => setReloadKey((value) => value + 1)} type="button">Повторить</button></div> : null}
      {items.length === 0 ? <div className="empty-state"><Icon name="trash" height={36} width={36} /><h3>Корзина пуста</h3><p className="muted">Здесь появятся удалённые файлы и папки.</p></div> : (
        <ul className="trash-list" aria-label="Удалённые файлы и папки">{items.map((item) => {
          const key = `${item.kind}:${item.id}`
          return <li className="trash-card" key={key}>
            <span className="item-icon"><Icon name={item.kind === 'folder' ? 'folder' : 'file'} /></span>
            <div className="trash-details">
              <h3 className="item-name">{item.name}</h3>
              <p className="muted">{item.kind === 'folder' ? 'Папка' : 'Файл'} · Удалено: <span className="mono">{item.deletedAt ? new Date(item.deletedAt).toLocaleString('ru-RU') : 'Дата неизвестна'}</span></p>
            </div>
            <div className="trash-actions">
              <button aria-label={`Восстановить ${item.name}`} className="button button--ghost" disabled={pending !== null} onClick={() => void mutate(`restore:${key}`, () => restoreTrashItem(item.kind, item.id), { kind: item.kind, id: item.id })} type="button">{pending === `restore:${key}` ? 'Восстанавливаем…' : 'Восстановить'}</button>
              <button aria-label={`Удалить ${item.name} навсегда`} className="button button--danger" disabled={pending !== null} onClick={() => setConfirmation({
                title: `Удалить «${item.name}» навсегда?`,
                confirmLabel: 'Удалить навсегда',
                run: () => void mutate(`delete:${key}`, () => permanentlyDelete(item.kind, item.id), { kind: item.kind, id: item.id }),
              })} type="button">{pending === `delete:${key}` ? 'Удаляем…' : 'Удалить навсегда'}</button>
            </div>
          </li>
        })}</ul>
      )}
      {confirmation ? <TrashConfirmation title={confirmation.title} confirmLabel={confirmation.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); confirmation.run() }} /> : null}
    </section>
  )
}

function TrashConfirmation({ title, confirmLabel, onClose, onConfirm }: { title: string; confirmLabel: string; onClose(): void; onConfirm(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocus(onClose, cancelRef)
  return <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="trash-confirm-title" aria-describedby="trash-confirm-description" ref={dialogRef} tabIndex={-1}>
    <div className="dialog-surface">
      <header className="dialog-header"><h3 id="trash-confirm-title">{title}</h3></header>
      <div className="dialog-body"><p className="muted" id="trash-confirm-description">Это действие нельзя отменить. Восстановить удалённые объекты не получится.</p></div>
      <div className="dialog-actions"><button className="button button--ghost" ref={cancelRef} onClick={onClose} type="button">Отмена</button><button className="button button--danger" onClick={onConfirm} type="button">{confirmLabel}</button></div>
    </div>
  </div>
}
