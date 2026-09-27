import { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import { ApiError } from './api/errors'
import { LoginPage } from './auth/LoginPage'
import { useSession } from './auth/SessionContext'
import { FileBrowserPage } from './files/FileBrowserPage'
import { ProtectedRoute } from './routing/ProtectedRoute'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/files" element={<FileBrowserLayout />} />
          <Route path="/files/folders/:folderId" element={<FileBrowserLayout />} />
        </Route>
        <Route path="/" element={<Navigate to="/files" replace />} />
      </Routes>
    </div>
  )
}

function FileBrowserLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <FileBrowserPage />
      </main>
    </div>
  )
}

function Navbar() {
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
        caught instanceof ApiError
          ? caught.message
          : 'Sign out could not be completed. Please try again.',
      )
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <nav className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900">HomeCloud</h1>
          </div>
          <div className="flex items-center gap-4">
            {logoutError ? <span className="text-sm text-red-700" role="alert">{logoutError}</span> : null}
            <button
              className="text-gray-700 hover:text-gray-900 disabled:opacity-60"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              type="button"
            >
              {loggingOut ? 'Signing out…' : 'Logout'}
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

export default App
