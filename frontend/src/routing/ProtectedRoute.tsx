import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { useSession } from '../auth/SessionContext'

export function ProtectedRoute() {
  const session = useSession()
  const location = useLocation()

  if (session.status === 'bootstrapping') {
    return <RouteState message="Restoring your session…" />
  }

  if (session.status === 'unavailable') {
    return (
      <RouteState
        message="HomeCloud is temporarily unavailable."
        actionLabel="Try again"
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
    <main className="min-h-screen flex items-center justify-center" role="status">
      <div className="text-center">
        <p className="text-gray-700">{message}</p>
        {actionLabel && onAction ? (
          <button className="mt-4 text-blue-600" onClick={onAction} type="button">
            {actionLabel}
          </button>
        ) : null}
      </div>
    </main>
  )
}
