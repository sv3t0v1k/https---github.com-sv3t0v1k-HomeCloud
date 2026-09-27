import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { useSession } from './SessionContext'

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session.status === 'bootstrapping') {
    return (
      <main className="min-h-screen flex items-center justify-center" role="status">
        Restoring your session…
      </main>
    )
  }

  if (session.status === 'authenticated') {
    return <Navigate to="/files" replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)

    try {
      await session.login(email, password)
      navigate(readReturnPath(location.state), { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Sign in could not be completed. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="max-w-md w-full mx-auto p-6">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-center mb-6">HomeCloud</h1>
          <h2 className="text-xl font-semibold mb-4">Sign In</h2>
          {session.status === 'anonymous' && session.notice ? (
            <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900" role="status">
              {session.notice}
            </p>
          ) : null}
          {error ? (
            <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="email">Email</label>
              <input
                autoComplete="email"
                className="w-full border rounded-md px-3 py-2"
                disabled={submitting}
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="password">Password</label>
              <input
                autoComplete="current-password"
                className="w-full border rounded-md px-3 py-2"
                disabled={submitting}
                id="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </div>
            <button
              className="w-full bg-blue-600 text-white rounded-md py-2 hover:bg-blue-700 disabled:opacity-60"
              disabled={submitting}
              type="submit"
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}

function readReturnPath(state: unknown): string {
  if (
    typeof state === 'object' &&
    state !== null &&
    'from' in state &&
    typeof state.from === 'string' &&
    state.from.startsWith('/') &&
    !state.from.startsWith('//')
  ) {
    return state.from
  }
  return '/files'
}
