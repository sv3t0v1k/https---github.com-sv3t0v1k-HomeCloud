export type SessionExpiredReason = 'expired'
type SessionExpiredListener = (reason: SessionExpiredReason) => void

const listeners = new Set<SessionExpiredListener>()

export function subscribeToSessionExpired(listener: SessionExpiredListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishSessionExpired(reason: SessionExpiredReason = 'expired') {
  listeners.forEach((listener) => listener(reason))
}
