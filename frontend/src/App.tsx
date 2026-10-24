import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom'

import { safeOperationError } from './files/operationErrors'
import { useDialogFocus } from './accessibility/useDialogFocus'
import { LoginPage } from './auth/LoginPage'
import { useSession } from './auth/SessionContext'
import { FileBrowserPage, UploadQueueProvider } from './files/FileBrowserPage'
import { TrashPage } from './files/TrashPage'
import { ProtectedRoute } from './routing/ProtectedRoute'
import { Icon } from './ui/Icon'
import { AccountDialog } from './account/AccountDialog'
import { PublicSharePage } from './sharing/PublicSharePage'

function App() {
  return (
    <div className="app-root">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/share/:token" element={<PublicSharePage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/files" element={<FileBrowserLayout />} />
          <Route path="/files/folders/:folderId" element={<FileBrowserLayout />} />
          <Route path="/files/trash" element={<FileBrowserLayout trash />} />
        </Route>
        <Route path="/" element={<Navigate to="/files" replace />} />
        <Route path="*" element={<div className="empty-state"><h2>Страница не найдена</h2><Link to="/files">К моим файлам</Link></div>} />
      </Routes>
    </div>
  )
}

function FileBrowserLayout({ trash = false }: { trash?: boolean }) {
  const session = useSession()
  const navigate = useNavigate()
  const [accountOpen, setAccountOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(trash)
  const [revision, setRevision] = useState(0)
  const backgroundRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (trash) setTrashOpen(true) }, [trash])
  function closeTrash() { setTrashOpen(false); setRevision((value) => value + 1); if (trash) navigate('/files', { replace: true }) }
  return <UploadQueueProvider key={session.user?.id ?? 0} ownerId={session.user?.id ?? 0}>
    <div className="app-shell ux-v2">
      <div className="app-frame" ref={backgroundRef}>
        <a className="skip-link" href="#workspace">Перейти к содержимому</a>
        <Navbar onOpenAccount={() => setAccountOpen(true)} />
        <main className="workspace" id="workspace" tabIndex={-1}><FileBrowserPage revision={revision} /></main>
        <button aria-label="Открыть корзину" className="button trash-launcher" onClick={(event) => { event.currentTarget.focus(); setTrashOpen(true) }} type="button"><Icon name="trash" /><span>Корзина</span></button>
      </div>
      {trashOpen ? <TrashDialog background={backgroundRef.current} onClose={closeTrash} /> : null}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </div>
  </UploadQueueProvider>
}

function TrashDialog({ background, onClose }: { background: HTMLElement | null; onClose(): void }) {
  const [confirming, setConfirming] = useState(false)
  const ref = useDialogFocus(onClose, undefined, !confirming)
  useEffect(() => {
    const overflow = document.body.style.overflow
    const inert = background?.inert ?? false
    if (background) background.inert = true
    document.body.style.overflow = 'hidden'
    return () => { if (background) background.inert = inert; document.body.style.overflow = overflow }
  }, [background])
  return <div className="dialog-overlay"><div aria-label="Корзина" aria-modal="true" className="dialog-surface trash-dialog" ref={ref} role="dialog" tabIndex={-1}>
    <div className="dialog-header"><h2>Удалённые объекты</h2><button aria-label="Закрыть корзину" className="icon-button" onClick={onClose} type="button"><Icon name="close" /></button></div>
    <TrashPage onConfirmationChange={setConfirming} />
  </div></div>
}

function Navbar({ onOpenAccount }: { onOpenAccount(): void }) {
  const session = useSession()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await session.logout()
    } catch (caught) {
      setLogoutError(
        safeOperationError(caught, 'Не удалось выйти. Повторите попытку.'),
      )
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <header className="topbar">
      <Link className="brand" to="/files"><span className="brand-mark"><Icon name="cloud" /></span><span>HomeCloud</span></Link>
      <div className="account-area">
        {session.status === 'authenticated' ? <button aria-label={`Открыть аккаунт: ${session.user.name}`} className="button button--ghost" onClick={(event) => { event.currentTarget.focus(); onOpenAccount() }} type="button"><Icon name="user" /><span>{session.user.name}</span></button> : null}
        {logoutError ? <span className="inline-alert" role="alert">{logoutError}</span> : null}

        <button className="button button--ghost" disabled={loggingOut} onClick={() => void handleLogout()} type="button">{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
    </header>
  )
}

export default App
