import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '../api/client'
import type { FileItem } from '../types/files'
import { PreviewModal } from './PreviewModal'
import { getFilePreview, previewImageBlob } from './preview'

describe('file preview API', () => {
  beforeEach(() => {
    apiClient.defaults.adapter = undefined
  })

  it('requests the authenticated preview contract by exact file id', async () => {
    let request: InternalAxiosRequestConfig | undefined
    apiClient.defaults.adapter = async (config) => {
      request = config
      return ok(config, { type: 'text', content: 'hello', mimeType: 'text/plain' })
    }

    await expect(getFilePreview(42)).resolves.toEqual({
      type: 'text', content: 'hello', mimeType: 'text/plain',
    })
    expect(request?.method).toBe('get')
    expect(request?.url).toBe('/previews/42')
    expect(request?.skipAuth).not.toBe(true)
  })

  it('converts the backend Buffer JSON shape without changing its MIME type', async () => {
    const blob = previewImageBlob({
      type: 'image', mimeType: 'image/png', content: { type: 'Buffer', data: [1, 2, 255] },
    })

    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(3)
  })
})

describe('PreviewModal', () => {
  const createObjectURL = vi.fn(() => 'blob:preview')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    apiClient.defaults.adapter = undefined
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders text and closes through the explicit control', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'text', content: 'preview body', mimeType: 'text/plain',
    })
    const onClose = vi.fn()
    render(<PreviewModal file={file(3, 'notes.txt')} onClose={onClose} />)

    expect(await screen.findByText('preview body')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('creates one image object URL and revokes it on close/unmount', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'image', content: { type: 'Buffer', data: [137, 80, 78, 71] }, mimeType: 'image/png',
    })
    const view = render(<PreviewModal file={file(4, 'photo.png', 'image/png')} onClose={() => undefined} />)

    expect(await screen.findByRole('img', { name: 'Preview of photo.png' })).toHaveAttribute('src', 'blob:preview')
    expect(createObjectURL).toHaveBeenCalledOnce()
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('aborts an outstanding request when closed by its parent', async () => {
    let aborted = false
    apiClient.defaults.adapter = async (config) => await new Promise<AxiosResponse>((_resolve, reject) => {
      config.signal?.addEventListener?.('abort', () => {
        aborted = true
        reject(new CanceledError('cancelled', config))
      }, { once: true })
    })
    const view = render(<PreviewModal file={file(5, 'slow.txt')} onClose={() => undefined} />)
    await screen.findByText('Loading preview…')

    view.unmount()
    expect(aborted).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels a stale request when switching files and shows only the current preview', async () => {
    let firstAborted = false
    let firstStarted = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/previews/6') {
        firstStarted = true
        return await new Promise<AxiosResponse>((_resolve, reject) => {
          config.signal?.addEventListener?.('abort', () => {
            firstAborted = true
            reject(new CanceledError('cancelled', config))
          }, { once: true })
        })
      }
      return ok(config, { type: 'text', content: 'second file', mimeType: 'text/plain' })
    }
    const view = render(<PreviewModal file={file(6, 'first.txt')} onClose={() => undefined} />)
    await waitFor(() => expect(firstStarted).toBe(true))
    view.rerender(<PreviewModal file={file(7, 'second.txt')} onClose={() => undefined} />)

    expect(await screen.findByText('second file')).toBeInTheDocument()
    expect(firstAborted).toBe(true)
    expect(screen.getByRole('heading')).toHaveTextContent('second.txt')
  })

  it('shows the backend unsupported result as an explicit bounded state', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'unsupported', content: 'internal backend wording', mimeType: 'text/plain',
    })
    render(<PreviewModal file={file(8, 'archive.zip', 'application/zip')} onClose={() => undefined} />)

    expect(await screen.findByText('Preview is not available for this file type.')).toBeInTheDocument()
    expect(screen.queryByText('internal backend wording')).not.toBeInTheDocument()
  })

  it.each([
    [400, 'Image exceeds maximum preview size', 'too large to preview'],
    [404, 'File not found on storage', 'no longer available'],
    [403, 'Forbidden', 'do not have permission'],
    [500, 'private /srv/storage/path', 'could not generate this preview'],
  ])('maps HTTP %s without exposing backend details', async (status, backendMessage, expected) => {
    apiClient.defaults.adapter = async (config) => { throw failure(config, status, backendMessage) }
    render(<PreviewModal file={file(9, 'problem.png', 'image/png')} onClose={() => undefined} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(expected)
    expect(alert).not.toHaveTextContent(backendMessage)
  })

  it('uses the existing session-expiry flow for an authentication failure', async () => {
    apiClient.defaults.adapter = async (config) => { throw failure(config, 401, 'token rejected') }
    render(<PreviewModal file={file(10, 'private.txt')} onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('session has expired')
  })
})

function file(id: number, name: string, mimeType = 'text/plain'): FileItem {
  return { id, name, mimeType, size: 1, isDeleted: false, isStarred: false, parentId: null, updatedAt: '2026-01-01T00:00:00Z' }
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}

function failure(config: InternalAxiosRequestConfig, status: number, message: string) {
  return new AxiosError('failed', undefined, config, undefined, {
    config, status, statusText: 'Error', headers: new AxiosHeaders(), data: { statusCode: status, message },
  })
}
