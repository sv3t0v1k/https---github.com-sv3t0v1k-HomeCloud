import { apiRequest } from '../api/client'

export type PreviewPayload =
  | { type: 'text'; content: string; mimeType: string }
  | { type: 'image'; content: { type: 'Buffer'; data: number[] }; mimeType: string }
  | { type: 'unsupported'; content: string; mimeType: string }

export function getFilePreview(fileId: number, signal?: AbortSignal) {
  return apiRequest<PreviewPayload>({
    method: 'GET',
    url: `/previews/${fileId}`,
    signal,
  })
}

export function previewImageBlob(preview: Extract<PreviewPayload, { type: 'image' }>): Blob {
  const bytes = preview.content
  if (bytes?.type !== 'Buffer' || !Array.isArray(bytes.data)) {
    throw new TypeError('The preview image response is invalid.')
  }
  return new Blob([new Uint8Array(bytes.data)], { type: preview.mimeType })
}
