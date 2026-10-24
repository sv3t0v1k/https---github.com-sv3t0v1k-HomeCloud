import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActionMenu } from '../ui/ActionMenu'
import { ApiError } from '../api/errors'
import { UploadQueue } from '../files/uploadQueue'
import { withChunkRetry, type RetryBudget } from '../files/upload'
import { PublicUploadTransport, publicUploadError } from './publicUploadTransport'
import { droppedEntries, inputEntries, manifest, pickDirectory, type TreeEntry } from './publicTree'

interface Node extends TreeEntry {
  key: string; deadline?: number; parentId?: number; actualId?: number; actualName?: string
  error?: string; fileJob?: string; budget: RetryBudget
}
interface Batch { target: number; targetName: string; nodes: Node[] }
interface Runtime { transport: PublicUploadTransport; queue: UploadQueue }

export function PublicUploadPanel({ token, password, parentId, targetName, onCommit }: {
  token: string; password: string; parentId?: number; targetName: string; onCommit(): void
}) {
  const [runtime, setRuntime] = useState<Runtime | null>(null)
  const [capability, setCapability] = useState('loading')
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [batch, setBatch] = useState<Batch>()
  const batchRef = useRef<Batch>()
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const [running, setRunning] = useState(false)
  const operation = useRef(false)
  const epoch = useRef(0)
  const [folderName, setFolderName] = useState('')
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const commitRef = useRef(onCommit); commitRef.current = onCommit

  useEffect(() => {
    const generation = ++epoch.current
    const transport = new PublicUploadTransport(token, password)
    const queue = new UploadQueue(0, null, transport)
    setRuntime({ transport, queue }); setCapability('loading'); setError(undefined)
    transport.authorize().then(() => { if (generation === epoch.current) setCapability('write') }).catch((cause: unknown) => {
      if (generation !== epoch.current) return
      if (cause instanceof ApiError && cause.status === 403) setCapability('read')
      else { setCapability('error'); setError(publicUploadError(cause)) }
    })
    return () => { epoch.current = generation + 1; queue.dispose(); transport.dispose() }
  }, [token, password, attempt])

  async function selectFolder() {
    if (operation.current || batchRef.current) return
    if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') { folderInput.current?.click(); return }
    operation.current = true; setRunning(true)
    const generation = epoch.current
    try {
      const entries = await pickDirectory()
      if (generation !== epoch.current) return
      if (entries) { operation.current = false; await start(entries) }
      else folderInput.current?.click()
    } catch (cause) { if ((cause as { name?: string }).name !== 'AbortError') setError(publicUploadError(cause)) }
    finally { operation.current = false; if (generation === epoch.current) setRunning(false) }
  }

  async function start(entries: TreeEntry[]) {
    if (!runtime || !parentId || batchRef.current || operation.current || capability !== 'write') return
    try {
      const nodes = manifest(entries).map((entry): Node => ({ ...entry, key: crypto.randomUUID(), budget: { remainingWaitMs: 300_000 } }))
      if (!nodes.length) throw new Error('Не обнаружено файлов или каталогов. Создайте пустую папку вручную.')
      const next = { target: parentId, targetName, nodes }
      batchRef.current = next; setBatch(next); setError(undefined); await execute(next)
    } catch (cause) { setError(publicUploadError(cause)) }
  }

  async function execute(current: Batch) {
    if (!runtime || operation.current) return
    const generation = epoch.current
    operation.current = true; setRunning(true); setError(undefined)
    const mapping = new Map<string, number>([['', current.target]])
    try {
      for (const node of current.nodes) {
        if (generation !== epoch.current) return
        const parent = node.path.split('/').slice(0, -1).join('/')
        const target = mapping.get(parent)
        if (!target) { node.error = 'Родительская папка не подтверждена.'; continue }
        if (node.parentId !== undefined && node.parentId !== target) throw new Error('Изменился родитель операции. Повтор остановлен.')
        node.parentId = target
        if (node.kind !== 'folder') continue
        try {
          node.deadline ??= Date.now() + 23 * 60 * 60_000
          if (Date.now() >= node.deadline) throw new Error('Истёк срок безопасного повтора. Уточните результат у владельца; не создавайте дубликат.')
          node.budget.remainingWaitMs = 300_000
          const result = await withChunkRetry(() => runtime.transport.mkdir(target, node.path.split('/').slice(-1)[0]!, node.key), undefined, 250, node.budget)
          if (generation !== epoch.current) return
          node.actualId = result.id; node.actualName = result.name; node.error = undefined
          mapping.set(node.path, result.id)
        } catch (cause) { node.error = publicUploadError(cause) }
        setBatch({ ...current })
      }
      for (const node of current.nodes.filter((entry) => entry.kind === 'file')) {
        if (generation !== epoch.current) return
        const target = mapping.get(node.path.split('/').slice(0, -1).join('/'))
        if (!target) { node.error = 'Родительская папка не подтверждена.'; if (node.fileJob) runtime.queue.pause(node.fileJob); continue }
        node.error = undefined
        if (node.fileJob) {
          const state = runtime.queue.getSnapshot().find((item) => item.id === node.fileJob)
          if (state?.state === 'completed' && state.uploadId) {
            try { await runtime.transport.request({ method: 'GET', url: `/uploads/session/${encodeURIComponent(state.uploadId)}` }) }
            catch (cause) { node.error = publicUploadError(cause) }
          }
          if (state?.state === 'error' || state?.state === 'paused') runtime.queue.resume(node.fileJob)
        } else if (node.file) {
          const file = new File([node.file], node.path.split('/').slice(-1)[0]!, { type: node.file.type, lastModified: node.file.lastModified })
          node.fileJob = runtime.queue.enqueue([file], target)[0]
        }
      }
      setBatch({ ...current })
    } catch (cause) { setError(publicUploadError(cause)) }
    finally { operation.current = false; if (generation === epoch.current) { setRunning(false); commitRef.current() } }
  }

  if (!runtime) return null
  return <Workspace runtime={runtime} capability={capability} error={error} batch={batch} running={running}
    parentId={parentId} folderName={folderName} setFolderName={setFolderName} filesInput={filesInput} folderInput={folderInput}
    refresh={() => { if (!batch) setAttempt((value) => value + 1) }}
    start={(entries) => void start(entries)} retry={() => batch && void execute(batch)}
    selectFolder={() => void selectFolder()} reportError={setError} onCommit={onCommit}
    clear={() => { setCapability('loading'); setAttempt((value) => value + 1); batchRef.current = undefined; setBatch(undefined); setError(undefined); setDiscardPrompt(false) }}
    discardPrompt={discardPrompt} askDiscard={() => setDiscardPrompt(true)} />
}

function Workspace({ runtime, capability, error, batch, running, parentId, folderName, setFolderName, filesInput, folderInput,
  refresh, start, retry, selectFolder, reportError, clear, onCommit, discardPrompt, askDiscard }: {
  runtime: Runtime; capability: string; error?: string; batch?: Batch; running: boolean; parentId?: number
  folderName: string; setFolderName(value: string): void
  filesInput: React.RefObject<HTMLInputElement>; folderInput: React.RefObject<HTMLInputElement>
  refresh(): void; start(entries: TreeEntry[]): void; retry(): void; selectFolder(): void
  reportError(message: string): void; clear(): void; onCommit(): void; discardPrompt: boolean; askDiscard(): void
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const items = useSyncExternalStore(runtime.queue.subscribe, runtime.queue.getSnapshot)
  const relevant = items.filter((item) => batch?.nodes.some((node) => node.fileJob === item.id))
  const active = running || relevant.some((item) => !['error', 'paused', 'completed', 'cancelled', 'needs-file'].includes(item.state))
  const disabled = active || !!batch || !parentId
  const completed = batch?.nodes.filter((node) => node.kind === 'folder' ? node.actualId && !node.error : !node.error && items.find((item) => item.id === node.fileJob)?.state === 'completed').length ?? 0
  const completedFiles = items.filter((item) => item.state === 'completed').length
  const lastCompleted = useRef(completedFiles)
  useEffect(() => {
    if (completedFiles > lastCompleted.current) onCommit()
    lastCompleted.current = completedFiles
  }, [completedFiles, onCommit])
  if (capability === 'loading') return <p role="status">Проверяем возможность загрузки…</p>
  if (capability === 'read') return <p className="muted">Только просмотр и скачивание.</p>
  if (capability === 'error') return <div><p role="alert">{error}</p><button type="button" className="button button--ghost" onClick={refresh}>Повторить проверку загрузки</button></div>
  return <section aria-label="Загрузка в общую папку" className="public-upload"
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      event.preventDefault()
      if (disabled) return
      void droppedEntries(event.dataTransfer.items, event.dataTransfer.files).then(start).catch((cause: unknown) => reportError(publicUploadError(cause)))
    }}>
    <h2>Добавить в папку</h2>
    <p className="muted">Можно перетащить файлы и папки сюда. Дерево загружается по частям: при ошибке уже созданные объекты сохраняются. Повтор продолжает прежние операции без дубликатов.</p>
    <p className="muted">Пустые файлы не поддерживаются. Выбор папки через список файлов может пропустить пустые каталоги; используйте перетаскивание папки или создайте их вручную. Лимиты размера и квоты проверяет сервер.</p>
    <ActionMenu label="Добавить" triggerLabel="Добавить" disabled={disabled} items={[
      { label: 'Загрузить файлы', icon: 'upload', onSelect: () => filesInput.current?.click() },
      { label: 'Загрузить папку', icon: 'folder', onSelect: selectFolder },
      { label: 'Новая папка', icon: 'plus', onSelect: () => setCreateOpen(true) },
    ]} />
    <input ref={filesInput} aria-label="Выбрать файлы" type="file" multiple hidden disabled={disabled} onChange={(event) => {
      try { start(inputEntries(event.target.files ?? [])) } catch (cause) { reportError(publicUploadError(cause)) }
      event.target.value = ''
    }} />
    <input ref={folderInput} aria-label="Выбрать папку" type="file" multiple hidden disabled={disabled} {...{ webkitdirectory: '', directory: '' }} onChange={(event) => {
      try { start(inputEntries(event.target.files ?? [])) } catch (cause) { reportError(publicUploadError(cause)) }
      event.target.value = ''
    }} />
    {createOpen ? <form onSubmit={(event) => { event.preventDefault(); start([{ kind: 'folder', path: folderName }]) }}>
      <label className="field">Имя новой папки<input className="input" required maxLength={255} value={folderName} disabled={disabled} onChange={(event) => setFolderName(event.target.value)} /></label>
      <button type="submit" className="button button--ghost" disabled={disabled}>Создать папку</button>
      <button type="button" className="button button--ghost" onClick={() => setCreateOpen(false)}>Отмена</button>
    </form> : null}
    {error ? <p className="alert alert--danger" role="alert">{error}</p> : null}
    {batch ? <details open className="public-upload-progress"><summary>Загрузки в общую папку · {completed}/{batch.nodes.length}</summary>
      <p role="status">Назначение: {batch.targetName}. Подтверждено: {completed} из {batch.nodes.length}.{active ? ' Загрузка продолжается…' : completed < batch.nodes.length ? ' Частичный результат: загрузка не завершена.' : ' Всё обнаруженное дерево загружено.'}</p>
      <p className="muted">Повтор доступен в этой вкладке. Закрытие или обновление страницы теряет очередь; файлы и папки у владельца сохранятся. Неполные сессии очистит сервер по сроку хранения.</p>
      <ul className="public-share-items">{batch.nodes.map((node) => {
        const item = items.find((entry) => entry.id === node.fileJob)
        return <li key={node.key} className="public-upload-result"><span>{node.path}</span><span>{node.kind === 'folder' ? node.actualName ? `Создана: ${node.actualName}` : 'Папка' : item?.completedFile ? `Сохранён: ${item.completedFile.name}` : item?.state === 'hashing' ? 'Проверяем SHA-256' : item?.state === 'error' ? 'Ошибка' : 'Ожидает или загружается'}</span>
          {item ? <progress aria-label={`Прогресс ${node.path}`} value={item.state === 'hashing' ? item.hashPercent : item.percent} max={100} /> : null}
          {node.error || item?.error ? <p role="alert">{node.error ?? item?.error} {item?.error ? 'Доступ, квота или ограничения могли измениться. Повтор использует прежнюю сессию.' : ''}</p> : null}
        </li>
      })}</ul>
      <button type="button" className="button button--primary" disabled={active || completed === batch.nodes.length} onClick={retry}>Повторить неудачные операции</button>
      {!active && completed < batch.nodes.length ? <button type="button" className="button button--ghost" onClick={askDiscard}>Завершить с частичным результатом</button> : null}
      {discardPrompt ? <div role="alert"><p>Созданные объекты сохранятся. Повтор этого задания будет потерян; повторный выбор тех же файлов может создать дубликаты.</p><button type="button" className="button button--ghost" disabled={active} onClick={clear}>Подтвердить завершение задания</button></div> : null}
      {completed === batch.nodes.length ? <button type="button" className="button button--ghost" disabled={active} onClick={clear}>Новая загрузка</button> : null}
    </details> : null}
  </section>
}
