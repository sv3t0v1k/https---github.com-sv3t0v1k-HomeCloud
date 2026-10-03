import { useLayoutEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, NavLink, Link } from 'react-router-dom'

import { safeOperationError } from './files/operationErrors'
import { useDialogFocus } from './accessibility/useDialogFocus'
import { LoginPage } from './auth/LoginPage'
import { useSession } from './auth/SessionContext'
import { FileBrowserPage } from './files/FileBrowserPage'
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
  const [navigationOpen, setNavigationOpen] = useState(false)
  const backgroundRef = useRef<HTMLDivElement>(null)
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">Перейти к содержимому</a>
      <aside aria-label="Основная навигация" className="sidebar sidebar-desktop"><SidebarContent trash={trash} /></aside>
      <div className="app-frame" ref={backgroundRef}>
        <Navbar navigationOpen={navigationOpen} onOpenNavigation={() => setNavigationOpen(true)} />
        <main className="workspace" id="workspace" tabIndex={-1}>
          {trash ? <TrashPage /> : <FileBrowserPage />}
        </main>
      </div>
      {navigationOpen ? <NavigationDrawer background={backgroundRef.current} trash={trash} onClose={() => setNavigationOpen(false)} /> : null}
    </div>
  )
}

function NavigationDrawer({ background, trash, onClose }: { background: HTMLElement | null; trash: boolean; onClose(): void }) {
  // Mount only while open: no hidden tab stops. Reuse the established dialog lifecycle.
  const dialogRef = useDialogFocus(onClose)
  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousInert = background?.inert ?? false
    if (background) background.inert = true
    document.body.style.overflow = 'hidden'
    const breakpoint = window.matchMedia('(min-width: 901px)')
    const closeOnDesktop = () => { if (breakpoint.matches) onClose() }
    breakpoint.addEventListener('change', closeOnDesktop)
    return () => {
      if (background) background.inert = previousInert
      document.body.style.overflow = previousOverflow
      breakpoint.removeEventListener('change', closeOnDesktop)
    }
  }, [background, onClose])
  return <div className="drawer-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div aria-label="Навигация" aria-modal="true" className="sidebar sidebar-drawer" id="mobile-navigation" ref={dialogRef} role="dialog" tabIndex={-1}>
      <button aria-label="Закрыть навигацию" className="icon-button drawer-close" onClick={onClose} type="button"><Icon name="close" /></button>
      <SidebarContent onNavigate={onClose} trash={trash} />
    </div>
  </div>
}

function SidebarContent({ trash, onNavigate }: { trash: boolean; onNavigate?(): void }) {
  const session = useSession()
  return <>
    <div className="brand"><span className="brand-mark"><Icon name="cloud" /></span><span>HomeCloud</span></div>
    <p className="nav-caption">ВАШЕ ПРОСТРАНСТВО</p>
    <nav className="sidebar-nav">
      <Link aria-current={!trash ? 'page' : undefined} className={`nav-item ${!trash ? 'nav-item--active' : ''}`} onClick={onNavigate} to="/files"><Icon name="home" />Мои файлы</Link>
      <NavLink className={`nav-item ${trash ? 'nav-item--active' : ''}`} onClick={onNavigate} to="/files/trash"><Icon name="trash" />Корзина</NavLink>
    </nav>
    <div className="sidebar-footer">
      <p className="sidebar-note">Ваши файлы.<br />На своём месте.</p>
      {session.status === 'authenticated' ? <div className="sidebar-account"><span className="avatar"><Icon name="user" /></span><span className="account-copy"><strong>{session.user.name}</strong><small>{session.user.email}</small></span></div> : null}
    </div>
  </>
}

function Navbar({ navigationOpen, onOpenNavigation }: { navigationOpen: boolean; onOpenNavigation(): void }) {
  const session = useSession()
  const [accountOpen, setAccountOpen] = useState(false)
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
      <button aria-label="Открыть навигацию" aria-expanded={navigationOpen} aria-controls="mobile-navigation" className="icon-button mobile-menu" onClick={onOpenNavigation} type="button"><Icon name="menu" /></button>
      <div className="topbar-context"><span className="eyebrow">Пространство</span><strong>Личное хранилище</strong></div>
      <div className="account-area">
        {logoutError ? <span className="inline-alert" role="alert">{logoutError}</span> : null}

        <button className="button button--ghost" onClick={(event) => { event.currentTarget.focus(); setAccountOpen(true) }} type="button">Аккаунт</button>
        <button className="button button--ghost" disabled={loggingOut} onClick={() => void handleLogout()} type="button">{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </header>
  )
}

export default App
