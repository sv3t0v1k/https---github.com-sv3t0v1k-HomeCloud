export function searchOrigin(pathname: string, state: unknown): string {
  if (/^\/files(?:\/folders\/[1-9]\d*)?$/.test(pathname)) return pathname
  const candidate = state && typeof state === 'object' && 'returnTo' in state ? state.returnTo : null
  return typeof candidate === 'string' && /^\/files(?:\/folders\/[1-9]\d*)?$/.test(candidate) ? candidate : '/files'
}

export function searchReturn(state: unknown): string | null {
  const candidate = state && typeof state === 'object' && 'searchReturn' in state ? state.searchReturn : null
  return typeof candidate === 'string' && /^\/files\/search(?:\?[^#]*)?$/.test(candidate) ? candidate : null
}

export function locatedTarget(state: unknown): { kind: 'file' | 'folder'; id: number } | null {
  const value = state && typeof state === 'object' && 'target' in state ? state.target : null
  if (!value || typeof value !== 'object' || !('kind' in value) || !('id' in value)) return null
  return (value.kind === 'file' || value.kind === 'folder') && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 ? { kind: value.kind, id: value.id } : null
}
