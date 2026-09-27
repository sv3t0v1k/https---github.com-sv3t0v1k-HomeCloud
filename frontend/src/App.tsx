import { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import { ApiError } from './api/errors'
import { LoginPage } from './auth/LoginPage'
import { useSession } from './auth/SessionContext'
import { ProtectedRoute } from './routing/ProtectedRoute'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/files/*" element={<FileBrowserLayout />} />
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
        <Routes>
          <Route path="/" element={<FileBrowser />} />
        </Routes>
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

function FileBrowser() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">My Files</h2>
      </div>
      <div className="bg-white rounded-lg shadow-sm border-2 border-dashed border-gray-300 p-8 text-center">
        <div className="flex flex-col items-center justify-center">
          <svg className="w-12 h-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-lg font-medium text-gray-700 mb-2">Drag and drop files here</p>
          <p className="text-sm text-gray-500">or click to browse</p>
        </div>
      </div>
      <div className="mt-6">
        <p className="text-gray-500 text-center">File list placeholder - integration pending</p>
      </div>
    </div>
  )
}

export default App
