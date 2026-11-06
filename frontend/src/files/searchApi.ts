import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import type { SearchPage } from './searchTypes'

export const SEARCH_PAGE_SIZE = 20
export const SEARCH_MAX_OFFSET = 10000

export function normalizeSearchQuery(value: string): string | null {
  const query = value.trim()
  if (query.length < 2 || query.length > 100 || [...query].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return null
  return query
}

export function parseSearchLocation(params: URLSearchParams): { query: string | null; offset: number; error: string | null } {
  const invalid = { query: null, offset: 0, error: 'Некорректный адрес поиска. Введите название заново.' }
  if ([...params.keys()].some((key) => !['q', 'offset', 'limit'].includes(key)) ||
      ['q', 'offset', 'limit'].some((key) => params.getAll(key).length > 1)) return invalid
  const rawQuery = params.get('q')
  if (rawQuery === null) return params.size === 0 ? { query: null, offset: 0, error: null } : invalid
  const query = normalizeSearchQuery(rawQuery)
  const rawOffset = params.get('offset') ?? '0'
  const offset = Number(rawOffset)
  if (!query || !/^(0|[1-9]\d*)$/.test(rawOffset) || !Number.isSafeInteger(offset) ||
      offset > SEARCH_MAX_OFFSET || (params.has('limit') && params.get('limit') !== String(SEARCH_PAGE_SIZE))) return invalid
  return { query, offset, error: null }
}

export function searchFiles(query: string, offset = 0, signal?: AbortSignal) {
  const normalized = normalizeSearchQuery(query)
  if (!normalized || !Number.isSafeInteger(offset) || offset < 0 || offset > SEARCH_MAX_OFFSET) {
    return Promise.reject(new ApiError('Некорректные параметры поиска.', 'validation', 400))
  }
  return apiRequest<SearchPage>({
    method: 'GET', url: '/files/search', params: { q: normalized, limit: SEARCH_PAGE_SIZE, offset }, signal,
  })
}

export function searchRetryAfter(value: string | undefined, now = Date.now()): number {
  if (value !== undefined && /^\d+$/.test(value)) {
    const seconds = Number(value)
    if (Number.isSafeInteger(seconds) && seconds <= 86400) return now + seconds * 1000
  }
  if (value !== undefined && !/^\d+$/.test(value)) {
    const date = Date.parse(value)
    if (Number.isFinite(date) && date > now && date - now <= 86400000) return date
  }
  return now + 60000
}
