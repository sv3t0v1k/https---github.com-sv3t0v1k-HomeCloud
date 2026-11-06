import { createContext, createElement, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { tokenStorage } from '../auth/tokenStorage'
import { ApiError } from '../api/errors'
import { normalizeSearchQuery, SEARCH_MAX_OFFSET, searchFiles, searchRetryAfter } from './searchApi'
import type { SearchPage } from './searchTypes'

type SearchSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: SearchPage | null
  error: ApiError | null
}

const idle: SearchSnapshot = { status: 'idle', data: null, error: null }
const SearchContext = createContext<SearchSession | null>(null)
const CACHE_TTL = 60000
const CACHE_LIMIT = 10

class SearchSession {
  private version = 0
  private listeners = new Set<() => void>()
  private pages = new Map<string, { value: SearchSnapshot; at: number }>()
  private leases = new Map<string, number>()
  private providers = 0
  private pending: { key: string; controller: AbortController } | null = null
  cooldownUntil = 0

  constructor(readonly ownerId: number, readonly generation: number) {}

  private current = () => this.ownerId > 0 && this.generation === tokenStorage.getOwnerGeneration()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getVersion = () => this.version
  private changed() { this.version += 1; this.listeners.forEach((listener) => listener()) }

  retain() { this.providers += 1 }
  release() {
    this.providers -= 1
    // React StrictMode immediately remounts effects. Keep that one request;
    // actual unmount/owner change still cancels and drops every cached page.
    queueMicrotask(() => {
      if (this.providers > 0) return
      this.pending?.controller.abort()
      this.pending = null
      this.pages.clear()
      this.cooldownUntil = 0
    })
  }

  snapshot(key: string | null): SearchSnapshot {
    return this.current() && key ? this.pages.get(key)?.value ?? idle : idle
  }

  private put(key: string, value: SearchSnapshot) {
    this.pages.delete(key)
    this.pages.set(key, { value, at: Date.now() })
    while (this.pages.size > CACHE_LIMIT) this.pages.delete(this.pages.keys().next().value!)
    this.changed()
  }

  acquire(query: string, offset: number) {
    const key = JSON.stringify([query, offset])
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    this.load(query, offset)
    return () => {
      this.leases.set(key, Math.max(0, (this.leases.get(key) ?? 1) - 1))
      queueMicrotask(() => {
        if ((this.leases.get(key) ?? 0) > 0) return
        this.leases.delete(key)
        if (this.pending?.key !== key) return
        this.pending.controller.abort()
        this.pending = null
        this.pages.delete(key)
        this.changed()
      })
    }
  }

  load(query: string, offset: number, force = false) {
    if (!this.current() || !normalizeSearchQuery(query) || !Number.isSafeInteger(offset) || offset < 0 || offset > SEARCH_MAX_OFFSET) return
    const key = JSON.stringify([query, offset])
    if (this.pending?.key === key) return
    const cached = this.pages.get(key)
    if (!force && cached && (cached.value.status === 'error' || (cached.value.status === 'ready' && Date.now() - cached.at < CACHE_TTL))) return
    if (this.pending) {
      const prior = this.pending
      prior.controller.abort()
      this.pending = null
      if (this.pages.get(prior.key)?.value.status === 'loading') this.pages.delete(prior.key)
    }
    if (Date.now() < this.cooldownUntil) {
      this.put(key, { status: 'error', data: cached?.value.data ?? null, error: new ApiError('Поиск временно ограничен.', 'rate-limit', 429) })
      return
    }
    const request = { key, controller: new AbortController() }
    this.pending = request
    this.put(key, { status: 'loading', data: cached?.value.data ?? null, error: null })
    void searchFiles(query, offset, request.controller.signal).then((data) => {
      if (this.pending !== request || request.controller.signal.aborted || !this.current()) return
      this.pending = null
      this.put(key, { status: 'ready', data, error: null })
    }).catch((cause: unknown) => {
      if (this.pending !== request || request.controller.signal.aborted || !this.current()) return
      this.pending = null
      const error = cause instanceof ApiError ? cause : new ApiError('Не удалось выполнить поиск.', 'unknown')
      if (error.status === 429) this.cooldownUntil = searchRetryAfter(error.retryAfter)
      this.put(key, { status: 'error', data: cached?.value.data ?? null, error })
    })
  }
}

export function SearchSessionProvider({ ownerId, children }: { ownerId: number; children: ReactNode }) {
  const generation = tokenStorage.getOwnerGeneration()
  const session = useMemo(() => new SearchSession(ownerId, generation), [ownerId, generation])
  useEffect(() => { session.retain(); return () => session.release() }, [session])
  return createElement(SearchContext.Provider, { value: session }, children)
}

export function useGlobalSearch(query: string | null, offset: number) {
  const session = useContext(SearchContext)
  if (!session) throw new Error('useGlobalSearch requires SearchSessionProvider')
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion)
  const key = query === null ? null : JSON.stringify([query, offset])
  useEffect(() => {
    if (query === null) return
    return session.acquire(query, offset)
  }, [session, query, offset])
  return {
    ...session.snapshot(key),
    cooldownUntil: session.cooldownUntil,
    retry: () => { if (query !== null) session.load(query, offset, true) },
  }
}
