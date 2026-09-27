import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react'

import { apiRequest, clearSession, refreshSession } from '../api/client'
import type { Tokens, User } from '../types/auth'
import { subscribeToSessionExpired } from './sessionEvents'
import { tokenStorage } from './tokenStorage'

type SessionState =
  | { status: 'bootstrapping'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: User }
  | { status: 'unavailable'; user: null }

type SessionContextValue = SessionState & {
  establishSession(tokens: Tokens): Promise<void>
  endSession(): void
  retryBootstrap(): Promise<void>
}

type SessionAction =
  | { type: 'BOOTSTRAP' }
  | { type: 'AUTHENTICATED'; user: User }
  | { type: 'ANONYMOUS' }
  | { type: 'UNAVAILABLE' }

const SessionContext = createContext<SessionContextValue | null>(null)

function reducer(_state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'BOOTSTRAP') return { status: 'bootstrapping', user: null }
  if (action.type === 'AUTHENTICATED') return { status: 'authenticated', user: action.user }
  if (action.type === 'UNAVAILABLE') return { status: 'unavailable', user: null }
  return { status: 'anonymous', user: null }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    status: 'bootstrapping',
    user: null,
  })

  const loadUser = useCallback(async () => {
    const user = await apiRequest<User>({ method: 'GET', url: '/users/me' })
    dispatch({ type: 'AUTHENTICATED', user })
  }, [])

  const bootstrap = useCallback(async () => {
    dispatch({ type: 'BOOTSTRAP' })
    if (!tokenStorage.getRefreshToken()) {
      dispatch({ type: 'ANONYMOUS' })
      return
    }

    try {
      await refreshSession()
      await loadUser()
    } catch {
      dispatch({
        type: tokenStorage.getRefreshToken() ? 'UNAVAILABLE' : 'ANONYMOUS',
      })
    }
  }, [loadUser])

  useEffect(() => {
    void bootstrap()
    return subscribeToSessionExpired(() => dispatch({ type: 'ANONYMOUS' }))
  }, [bootstrap])

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      async establishSession(tokens) {
        tokenStorage.set(tokens)
        await loadUser()
      },
      endSession() {
        clearSession()
        dispatch({ type: 'ANONYMOUS' })
      },
      retryBootstrap: bootstrap,
    }),
    [bootstrap, loadUser, state],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession must be used inside SessionProvider')
  return context
}
