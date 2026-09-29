import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { useSession } from '../auth/SessionContext'

export function ProtectedRoute() {
  const session = useSession()
  const location = useLocation()

  if (session.status === 'bootstrapping') {
    return <RouteState message="Восстанавливаем сеанс…" />
  }

  if (session.status === 'unavailable') {
    return (
      <RouteState
        message="HomeCloud временно недоступен."
        actionLabel="Попробовать снова"
        onAction={() => void session.retryBootstrap()}
      />
    )
  }

  if (session.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}

function RouteState({
  message,
  actionLabel,
  onAction,
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <main className="auth-page" role="status">
      <div className="route-state">
        <p className="muted">{message}</p>
        {actionLabel && onAction ? (
          <button className="button button--primary" onClick={onAction} type="button">
            {actionLabel}
          </button>
        ) : null}
      </div>
    </main>
  )
}
