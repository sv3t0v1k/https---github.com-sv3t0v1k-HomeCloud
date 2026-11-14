import { apiClient } from '../api/client'
import { tokenStorage } from '../auth/tokenStorage'

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

export async function fetchFileThumbnail(
  fileId: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    throw new RangeError('Invalid thumbnail file ID')
  }

  const ownerGeneration = tokenStorage.getOwnerGeneration()

  const response = await apiClient.get<Blob>(
    `/previews/${fileId}/thumbnail`,
    {
      responseType: 'blob',
      signal,
      ownerGenerationUsed: ownerGeneration,
    },
  )

  if (
    signal?.aborted ||
    ownerGeneration !== tokenStorage.getOwnerGeneration()
  ) {
    throw new Error('Thumbnail request belongs to an old session')
  }

  const blob = response.data

  if (
    !(blob instanceof Blob) ||
    blob.type !== 'image/png' ||
    blob.size === 0 ||
    blob.size > MAX_THUMBNAIL_BYTES
  ) {
    throw new TypeError('Invalid thumbnail response')
  }

  return blob
}
