import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  AxiosHeaders,
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

function file(id: number, name: string, size: string | number) {
  return {
    id,
    name,
    size,
    mimeType: 'text/plain',
    isDeleted: false,
    isStarred: false,
    parentId: null,
    updatedAt: '2026-01-01T00:00:00Z',
  }
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
