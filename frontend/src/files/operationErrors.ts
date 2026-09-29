import { ApiError } from '../api/errors'

export function safeOperationError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback
  if (error.kind === 'network') return 'Сервер недоступен. Проверьте подключение и повторите попытку.'
  if (error.kind === 'authentication' || error.status === 401) return 'Сессия истекла. Войдите снова.'
  if (error.status === 404) return 'Объект удалён или недоступен.'
  if (error.status === 403) return 'Недостаточно прав для этой операции.'
  if (error.status === 400 || error.status === 422) {
    const message = error.message.toLowerCase()
    if (message.includes('name')) return 'Введите название от 1 до 255 символов.'
    if (message.includes('subtree') || message.includes('cycle')) return 'Нельзя переместить папку внутрь неё самой или её вложенной папки.'
    return 'Проверьте папку назначения и введённые значения.'
  }
  if (error.status === 409) return 'Объект с таким названием уже существует в папке назначения.'
  if (error.kind === 'server') return 'Не удалось выполнить операцию. Повторите попытку.'
  return fallback
}
