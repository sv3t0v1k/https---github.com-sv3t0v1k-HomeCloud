import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { ApiError } from '../api/errors'
import { Icon } from '../ui/Icon'
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
      <main className="auth-page" role="status">
        Восстанавливаем сеанс…
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
        loginErrorMessage(caught),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-layout">
        <div className="auth-card">
          <h1 className="auth-brand"><Icon name="cloud" height={32} width={32} />HomeCloud</h1>
          <h2 className="page-heading">Войти</h2>
          <p className="page-description">Ваши файлы — в одном месте.</p>
          {session.status === 'anonymous' && session.notice ? (
            <p className="alert alert--warning" role="status">
              {session.notice}
            </p>
          ) : null}
          {error ? (
            <p className="alert alert--danger" role="alert">
              {error}
            </p>
          ) : null}
          <form className="auth-form" onSubmit={handleSubmit}>
            <div>
              <label className="field" htmlFor="email">Электронная почта</label>
              <input
                autoComplete="email"
                className="input"
                disabled={submitting}
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </div>
            <div>
              <label className="field" htmlFor="password">Пароль</label>
              <input
                autoComplete="current-password"
                className="input"
                disabled={submitting}
                id="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </div>
            <button
              className="button button--primary"
              disabled={submitting}
              type="submit"
            >
              {submitting ? 'Входим…' : 'Войти'}
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

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось войти. Попробуйте ещё раз.'
  if (error.kind === 'authentication') return 'Неверная электронная почта или пароль.'
  if (error.kind === 'authorization') return 'Доступ к аккаунту ограничен.'
  if (error.kind === 'validation') return 'Проверьте электронную почту и пароль.'
  if (error.kind === 'rate-limit') return 'Слишком много попыток входа. Попробуйте позже.'
  if (error.kind === 'network') return 'Сервер недоступен. Проверьте соединение и попробуйте ещё раз.'
  return 'Не удалось войти. Попробуйте ещё раз.'
}
