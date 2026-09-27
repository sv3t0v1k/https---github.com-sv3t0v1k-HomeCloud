type SessionExpiredListener = () => void

const listeners = new Set<SessionExpiredListener>()

export function subscribeToSessionExpired(listener: SessionExpiredListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishSessionExpired() {
  listeners.forEach((listener) => listener())
}
