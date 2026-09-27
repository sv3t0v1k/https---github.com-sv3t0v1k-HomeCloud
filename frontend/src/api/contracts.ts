export interface ApiEnvelope<T> {
  success: true
  data: T
}

export interface BackendErrorBody {
  statusCode?: number
  message?: string
  timestamp?: string
  path?: string
}
