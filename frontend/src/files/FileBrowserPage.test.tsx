import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { apiClient } from '../api/client'
import { FileBrowserPage } from './FileBrowserPage'

describe('FileBrowserPage', () => {
  afterEach(cleanup)
  beforeEach(() => {
    apiClient.defaults.adapter = undefined
  })

  it('loads root folders and files, then navigates with the FolderEntity id', async () => {
    const nestedParentIds: number[] = []
    apiClient.defaults.adapter = async (config) => {
      const parentId = config.params?.parentId as number | undefined
      if (parentId !== undefined) nestedParentIds.push(parentId)
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Documents', null))
      if (config.url === '/files/folders') {
        return ok(config, parentId ? [] : [folder(7, 'Documents', null)])
      }
      if (config.url === '/files') {
        return ok(config, parentId ? [] : [file(11, 'report.txt', '2048')])
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    expect(await screen.findByText('report.txt')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Documents' }))

    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument()
    expect(nestedParentIds).toEqual([7, 7])
  })

  it('reconstructs named breadcrumbs on a direct nested load', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders/9') return ok(config, folder(9, 'Child', 3))
      if (config.url === '/files/folders/3') return ok(config, folder(3, 'Parent', null))
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') return ok(config, [file(20, 'inside.txt', 12)])
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files/folders/9')

    const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(breadcrumb).toHaveTextContent('My Files/Parent/Child')
    expect(screen.getByText('inside.txt')).toBeInTheDocument()
  })

  it('shows a recoverable whole-directory error and retries both lists', async () => {
    let fileCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') {
        fileCalls += 1
        if (fileCalls === 1) throw serverError(config)
        return ok(config, [])
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('Server error')
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument()
    expect(fileCalls).toBe(2)
  })

  it('rejects malformed folder ids without making a request', async () => {
    let calls = 0
    apiClient.defaults.adapter = async (config) => {
      calls += 1
      return ok(config, [])
    }

    renderPage('/files/folders/12junk')

    expect(await screen.findByRole('alert')).toHaveTextContent('folder address is invalid')
    expect(calls).toBe(0)
  })

  it.each([
    [404, 'does not exist or is not available'],
    [403, 'do not have permission'],
  ])('renders a distinct access state for HTTP %s', async (status, message) => {
    apiClient.defaults.adapter = async (config) => {
      throw responseFailure(config, status)
    }

    renderPage('/files/folders/7')

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Return to My Files' })).toBeInTheDocument()
  })

  it('uploads into the current folder and refreshes its listing after completion', async () => {
    let completed = false
    const sessionPayloads: unknown[] = []
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders/9') return ok(config, folder(9, 'Child', null))
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') {
        return ok(config, completed ? [file(31, 'new.png', 4, 9)] : [])
      }
      if (config.url === '/uploads/session') {
        sessionPayloads.push(JSON.parse(String(config.data)))
        return created(config, { uploadId: 'upload-1', totalChunks: 1 })
      }
      if (config.url === '/uploads/session/upload-1/chunk') return ok(config, {})
      if (config.url === '/uploads/session/upload-1/complete') {
        completed = true
        return ok(config, file(31, 'new.png', 4, 9))
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files/folders/9')
    const user = userEvent.setup()
    await screen.findByText('This folder is empty.')
    const selected = new File([new Uint8Array([1, 2, 3, 4])], 'new.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Choose a file to upload'), selected)
    expect(screen.getByText(/Selected: new.png/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText('new.png uploaded successfully.')).toBeInTheDocument()
    expect(await screen.findByText('new.png', { selector: 'td' })).toBeInTheDocument()
    expect(sessionPayloads).toEqual([{ filename: 'new.png', totalSize: 4, chunkSize: 10 * 1024 * 1024, parentId: 9 }])
  })

  it('maps upload quota failures to an actionable message', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders' || config.url === '/files') return ok(config, [])
      if (config.url === '/uploads/session') {
        throw responseFailure(config, 403, 'Storage quota exceeded')
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByText('This folder is empty.')
    await user.upload(
      screen.getByLabelText('Choose a file to upload'),
      new File([new Uint8Array([1])], 'small.png', { type: 'image/png' }),
    )
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('not enough storage space')
  })

  it('blocks an oversized browser download before issuing a request', async () => {
    let downloadRequests = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') return ok(config, [file(44, 'archive.zip', 101 * 1024 * 1024)])
      if (config.url?.includes('/download')) downloadRequests += 1
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Download archive.zip' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('limited to 100 MB')
    expect(downloadRequests).toBe(0)
  })

  it('cancels an active upload when navigation changes the current folder', async () => {
    let chunkAborted = false
    let completeCalls = 0
    let deleteCalls = 0
    apiClient.defaults.adapter = async (config) => {
      const parentId = config.params?.parentId as number | undefined
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Documents', null))
      if (config.url === '/files/folders') return ok(config, parentId ? [] : [folder(7, 'Documents', null)])
      if (config.url === '/files') return ok(config, [])
      if (config.url === '/uploads/session') return created(config, { uploadId: 'u-nav', totalChunks: 1 })
      if (config.url === '/uploads/session/u-nav/chunk') {
        return await new Promise<AxiosResponse>((_resolve, reject) => {
          config.signal?.addEventListener?.('abort', () => {
            chunkAborted = true
            reject(new CanceledError('cancelled', config))
          }, { once: true })
        })
      }
      if (config.url === '/uploads/session/u-nav/complete') {
        completeCalls += 1
        return ok(config, file(1, 'never.png', 1))
      }
      if (config.method === 'delete') {
        deleteCalls += 1
        return ok(config, undefined)
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Documents' })
    await user.upload(
      screen.getByLabelText('Choose a file to upload'),
      new File([new Uint8Array([1])], 'moving.png', { type: 'image/png' }),
    )
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByRole('button', { name: 'Cancel upload' })
    await user.click(screen.getByRole('button', { name: 'Documents' }))

    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument()
    expect(chunkAborted).toBe(true)
    expect(completeCalls).toBe(0)
    expect(deleteCalls).toBe(1)
  })

  it.each([
    ['File size exceeds allowed maximum', 'exceeds the upload limit'],
    ['File type application/octet-stream is not allowed for upload', 'file type is not allowed'],
    ['Upload session expired', 'upload session expired'],
  ])('maps upload failure "%s" without showing success', async (backendMessage, expectedMessage) => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders' || config.url === '/files') return ok(config, [])
      if (config.url === '/uploads/session') {
        if (backendMessage.startsWith('File size')) throw responseFailure(config, 400, backendMessage)
        return created(config, { uploadId: 'u-error', totalChunks: 1 })
      }
      if (config.url === '/uploads/session/u-error/chunk') {
        if (backendMessage.startsWith('Upload session')) throw responseFailure(config, 400, backendMessage)
        return ok(config, {})
      }
      if (config.url === '/uploads/session/u-error/complete') {
        throw responseFailure(config, 400, backendMessage)
      }
      if (config.method === 'delete') return ok(config, undefined)
      throw new Error(`Unexpected request: ${config.url}`)
    }

    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByText('This folder is empty.')
    await user.upload(
      screen.getByLabelText('Choose a file to upload'),
      new File([new Uint8Array([1])], 'bad.bin', { type: 'application/octet-stream' }),
    )
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage)
    expect(screen.queryByText(/uploaded successfully/)).not.toBeInTheDocument()
  })
})

function renderPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/files" element={<FileBrowserPage />} />
        <Route path="/files/folders/:folderId" element={<FileBrowserPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function folder(id: number, name: string, parentId: number | null) {
  return { id, name, parentId, isDeleted: false, updatedAt: '2026-01-01T00:00:00Z' }
}

function file(id: number, name: string, size: string | number, parentId: number | null = null) {
  return {
    id,
    name,
    size,
    mimeType: 'text/plain',
    isDeleted: false,
    isStarred: false,
    parentId,
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function created(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { ...ok(config, data), status: 201, statusText: 'Created' }
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    config,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    data: { success: true, data },
  }
}

function serverError(config: InternalAxiosRequestConfig) {
  return responseFailure(config, 500, 'Server error')
}

function responseFailure(
  config: InternalAxiosRequestConfig,
  status: number,
  message = 'Request failed',
) {
  return new AxiosError('failed', undefined, config, undefined, {
    config,
    status,
    statusText: 'Error',
    headers: new AxiosHeaders(),
    data: { statusCode: status, message },
  })
}
