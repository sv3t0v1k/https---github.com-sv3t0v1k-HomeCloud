import { ApiError } from '../api/errors'
import { getFolder } from './api'

export interface SearchCrumb { id: number; name: string }
export type PathCache = Map<number, { id: number; name: string; parentId: number | null; at: number }>

// Only follow the ancestry of the explicitly selected result. Never enumerate children.
export async function resolveSearchPath(parentId: number | null, cache: PathCache, signal: AbortSignal): Promise<SearchCrumb[]> {
  const reversed: SearchCrumb[] = []
  const visited = new Set<number>()
  let current = parentId
  while (current !== null) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (!Number.isSafeInteger(current) || current <= 0 || visited.has(current) || visited.size >= 256) {
      throw new ApiError('Расположение недоступно', 'validation', 400)
    }
    visited.add(current)
    let folder = cache.get(current)
    if (!folder || Date.now() - folder.at >= 60_000) {
      const fetched = await getFolder(current, signal)
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (fetched.id !== current || typeof fetched.name !== 'string' ||
        (fetched.parentId !== null && (!Number.isSafeInteger(fetched.parentId) || fetched.parentId <= 0))) {
        throw new ApiError('Расположение недоступно', 'validation', 400)
      }
      folder = { id: fetched.id, name: fetched.name, parentId: fetched.parentId, at: Date.now() }
      if (cache.size >= 256) cache.delete(cache.keys().next().value!)
      cache.set(current, folder)
    }
    reversed.push({ id: folder.id, name: folder.name })
    current = folder.parentId
  }
  return reversed.reverse()
}
