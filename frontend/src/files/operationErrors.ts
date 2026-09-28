import { ApiError } from '../api/errors'

export function safeOperationError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback
  if (error.kind === 'network') return 'The server is unavailable. Check your connection and try again.'
  if (error.kind === 'authentication' || error.status === 401) return 'Your session has expired. Please sign in again.'
  if (error.status === 404) return 'This item no longer exists or is not available.'
  if (error.status === 403) return 'You do not have access to complete this operation.'
  if (error.status === 400 || error.status === 422) {
    const message = error.message.toLowerCase()
    if (message.includes('name')) return 'Enter a valid non-empty name of at most 255 characters.'
    if (message.includes('subtree') || message.includes('cycle')) return 'A folder cannot be moved inside itself or one of its descendants.'
    return 'The requested destination or value is invalid.'
  }
  if (error.status === 409) return 'An item with that name already exists in the destination.'
  if (error.kind === 'server') return 'The server could not complete the operation. Please try again.'
  return fallback
}
