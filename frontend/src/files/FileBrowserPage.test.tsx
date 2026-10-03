import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

import { apiClient } from '../api/client'
import { FileBrowserPage } from './FileBrowserPage'

describe('FileBrowserPage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
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
    expect(screen.getByRole('button', { name: 'Documents' }).closest('tr')).not.toHaveTextContent(/0 Б|байт/)
    expect(screen.getByRole('button', { name: 'report.txt' }).closest('tr')).toHaveTextContent('2 КБ')
    await user.click(screen.getByRole('button', { name: 'Documents' }))

    expect(await screen.findByText('В этой папке пока пусто')).toBeInTheDocument()
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

    const breadcrumb = await screen.findByRole('navigation', { name: 'Путь к папке' })
    expect(breadcrumb).toHaveTextContent('Мои файлы/Parent/Child')
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выполнить операцию')
    await user.click(screen.getByRole('button', { name: 'Повторить' }))

    expect(await screen.findByText('В этой папке пока пусто')).toBeInTheDocument()
    expect(fileCalls).toBe(2)
  })

  it('rejects malformed folder ids without making a request', async () => {
    let calls = 0
    apiClient.defaults.adapter = async (config) => {
      calls += 1
      return ok(config, [])
    }

    renderPage('/files/folders/12junk')

    expect(await screen.findByRole('alert')).toHaveTextContent('Некорректный адрес папки')
    expect(calls).toBe(0)
  })

  it.each([
    [404, 'не существует или недоступна'],
    [403, 'нет доступа'],
  ])('renders a distinct access state for HTTP %s', async (status, message) => {
    apiClient.defaults.adapter = async (config) => {
      throw responseFailure(config, status)
    }

    renderPage('/files/folders/7')

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'К моим файлам' })).toBeInTheDocument()
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
    await screen.findByText('В этой папке пока пусто')
    const selected = new File([new Uint8Array([1, 2, 3, 4])], 'new.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Выбрать файл для загрузки'), selected)
    expect(screen.getByText(/Выбран файл: new.png/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Загрузить' }))

    expect(await screen.findByText('new.png — файл загружен.')).toBeInTheDocument()
    expect(await screen.findByText('new.png', { selector: 'button' })).toBeInTheDocument()
    expect(sessionPayloads).toEqual([{ filename: 'new.png', totalSize: 4, chunkSize: 10 * 1024 * 1024, parentId: 9 }])
    await user.upload(screen.getByLabelText('Выбрать файл для загрузки'), selected)
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Загрузить' }))
    await waitFor(() => expect(sessionPayloads).toHaveLength(2))
  })

  it('offers deep sibling destinations and excludes a moved folder subtree', async () => {
    const mutations: unknown[] = []
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Source', null))
      if (config.url === '/files/folders' && config.method === 'get') {
        const parent = config.params?.parentId
        return ok(config, parent === undefined ? [folder(7, 'Source', null), folder(8, 'Sibling', null)] : parent === 7 ? [folder(9, 'Moving', 7)] : parent === 8 ? [folder(10, 'Deep', 8)] : parent === 9 ? [folder(11, 'Child', 9)] : [])
      }
      if (config.url === '/files') return ok(config, [file(20, 'inside.txt', 4)])
      if (config.url === '/files/20/move') { mutations.push(JSON.parse(String(config.data))); return ok(config, {}) }
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderPage('/files/folders/7')
    const user = userEvent.setup()
    await chooseAction(user, 'inside.txt', 'Переместить')
    await screen.findByRole('option', { name: 'Sibling / Deep' })
    await waitFor(() => expect(screen.getByLabelText('Папка назначения')).toBeEnabled())
    await user.selectOptions(screen.getByLabelText('Папка назначения'), '10')
    await user.click(screen.getByRole('button', { name: 'Переместить' }))
    await waitFor(() => expect(mutations).toContainEqual({ targetParentId: 10 }))
    await chooseAction(user, 'Moving', 'Переместить')
    await screen.findByRole('option', { name: 'Sibling / Deep' })
    expect(screen.queryByRole('option', { name: /Moving|Child/ })).not.toBeInTheDocument()
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
    await screen.findByText('В этой папке пока пусто')
    await user.upload(
      screen.getByLabelText('Выбрать файл для загрузки'),
      new File([new Uint8Array([1])], 'small.png', { type: 'image/png' }),
    )
    await user.click(screen.getByRole('button', { name: 'Загрузить' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Недостаточно места')
    expect(screen.getByRole('button', { name: 'Повторить загрузку' })).toBeEnabled()
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
    await chooseAction(user, 'archive.zip', 'Скачать')

    expect(await screen.findByRole('alert')).toHaveTextContent('до 100 МБ')
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
      screen.getByLabelText('Выбрать файл для загрузки'),
      new File([new Uint8Array([1])], 'moving.png', { type: 'image/png' }),
    )
    await user.click(screen.getByRole('button', { name: 'Загрузить' }))
    await screen.findByRole('button', { name: 'Отменить загрузку' })
    await user.click(screen.getByRole('button', { name: 'Documents' }))

    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument()
    expect(chunkAborted).toBe(true)
    expect(completeCalls).toBe(0)
    expect(deleteCalls).toBe(1)
  })

  it.each([
    ['File size exceeds allowed maximum', 'превышает ограничение загрузки'],
    ['File type application/octet-stream is not allowed for upload', 'тип файла не разрешён'],
    ['Upload session expired', 'Срок загрузки истёк'],
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
    await screen.findByText('В этой папке пока пусто')
    await user.upload(
      screen.getByLabelText('Выбрать файл для загрузки'),
      new File([new Uint8Array([1])], 'bad.bin', { type: 'application/octet-stream' }),
    )
    await user.click(screen.getByRole('button', { name: 'Загрузить' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage)
    expect(screen.queryByText(/файл загружен/)).not.toBeInTheDocument()
  })

  it('creates a folder and refreshes the current listing', async () => {
    let created = false
    let payload: unknown
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders' && config.method === 'get') return ok(config, created ? [folder(8, 'New folder', null)] : [])
      if (config.url === '/files') return ok(config, [])
      if (config.url === '/files/folders' && config.method === 'post') { payload = JSON.parse(String(config.data)); created = true; return createdResponse(config, {}) }
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByText('В этой папке пока пусто')
    await user.click(screen.getByRole('button', { name: 'Новая папка' }))
    await user.type(await screen.findByLabelText('Название папки'), 'New folder')
    await user.click(screen.getByRole('button', { name: 'Создать папку' }))
    expect(await screen.findByRole('button', { name: 'New folder' })).toBeInTheDocument()
    expect(payload).toEqual({ name: 'New folder' })
  })

  it('renames, moves, copies and trashes files with refresh and confirmation', async () => {
    let present = true
    const mutations: Array<{ url?: string; method?: string; data?: unknown }> = []
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [folder(7, 'Destination', null)])
      if (config.url === '/files') return ok(config, present ? [file(11, 'report.txt', 2)] : [])
      mutations.push({ url: config.url, method: config.method, data: config.data ? JSON.parse(String(config.data)) : undefined })
      if (config.url === '/files/11' && config.method === 'delete') present = false
      return ok(config, {})
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'report.txt', 'Переименовать')
    await user.clear(screen.getByLabelText('Новое название'))
    await user.type(screen.getByLabelText('Новое название'), 'renamed.txt')
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    await waitFor(() => expect(mutations).toHaveLength(1))
    await chooseAction(user, 'report.txt', 'Переместить')
    await waitFor(() => expect(screen.getByLabelText('Папка назначения')).toBeEnabled())
    await user.selectOptions(screen.getByLabelText('Папка назначения'), '7')
    await user.click(screen.getByRole('button', { name: 'Переместить' }))
    await waitFor(() => expect(mutations).toHaveLength(2))
    await chooseAction(user, 'report.txt', 'Копировать')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Копировать' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Копировать' }))
    await waitFor(() => expect(mutations).toHaveLength(3))
    await chooseAction(user, 'report.txt', 'В корзину')
    await user.click(screen.getByRole('button', { name: 'Переместить в корзину' }))
    await waitFor(() => expect(screen.queryByText('report.txt', { selector: 'button' })).not.toBeInTheDocument())
    expect(mutations).toEqual(expect.arrayContaining([
      { url: '/files/11', method: 'patch', data: { name: 'renamed.txt' } },
      { url: '/files/11/move', method: 'post', data: { targetParentId: 7 } },
      { url: '/files/11/copy', method: 'post', data: {} },
      { url: '/files/11', method: 'delete', data: undefined },
    ]))
  })

  it('makes the previous folder non-actionable immediately after navigation', async () => {
    let mutationCalls = 0
    apiClient.defaults.adapter = async (config) => {
      const parentId = config.params?.parentId as number | undefined
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Destination', null))
      if (config.url === '/files/folders' && parentId === 7) return await new Promise<AxiosResponse>(() => undefined)
      if (config.url === '/files' && parentId === 7) return await new Promise<AxiosResponse>(() => undefined)
      if (config.url === '/files/folders') return ok(config, [folder(7, 'Destination', null)])
      if (config.url === '/files') return ok(config, [file(11, 'old.txt', 1)])
      mutationCalls += 1
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Действия: old.txt' })
    await user.click(screen.getByRole('button', { name: 'Destination' }))
    expect(screen.queryByRole('button', { name: 'Действия: old.txt' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка файлов')
    expect(mutationCalls).toBe(0)
  })

  it('keeps the duplicate mutation guard enforced while navigation replaces the view', async () => {
    let mutationCalls = 0
    let finishMutation!: (value: AxiosResponse) => void
    apiClient.defaults.adapter = async (config) => {
      const parentId = config.params?.parentId as number | undefined
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Destination', null))
      if (config.url === '/files/folders' && parentId === 7) return await new Promise<AxiosResponse>(() => undefined)
      if (config.url === '/files' && parentId === 7) return await new Promise<AxiosResponse>(() => undefined)
      if (config.url === '/files/folders') return ok(config, [folder(7, 'Destination', null)])
      if (config.url === '/files') return ok(config, [file(11, 'old.txt', 1)])
      if (config.url === '/files/11' && config.method === 'patch') {
        mutationCalls += 1
        return await new Promise<AxiosResponse>((resolve) => { finishMutation = resolve })
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderNavigablePage()
    const user = userEvent.setup()
    await chooseAction(user, 'old.txt', 'Переименовать')
    await user.clear(screen.getByLabelText('Новое название'))
    await user.type(screen.getByLabelText('Новое название'), 'renamed.txt')
    await user.dblClick(screen.getByRole('button', { name: 'Переименовать' }))
    expect(mutationCalls).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Go to current folder' }))
    expect(screen.queryByRole('button', { name: 'Действия: old.txt' })).not.toBeInTheDocument()
    expect(mutationCalls).toBe(1)
    finishMutation(ok({} as InternalAxiosRequestConfig, {}))
  })

  it('discards a superseded listing that resolves after the current folder', async () => {
    let finishOldFolders!: (value: AxiosResponse) => void
    let finishOldFiles!: (value: AxiosResponse) => void
    apiClient.defaults.adapter = async (config) => {
      const parentId = config.params?.parentId as number | undefined
      if (config.url === '/files/folders/7') return ok(config, folder(7, 'Current', null))
      if (config.url === '/files/folders' && parentId === 7) return ok(config, [])
      if (config.url === '/files' && parentId === 7) return ok(config, [file(22, 'current.txt', 1, 7)])
      if (config.url === '/files/folders') return await new Promise<AxiosResponse>((resolve) => { finishOldFolders = resolve })
      if (config.url === '/files') return await new Promise<AxiosResponse>((resolve) => { finishOldFiles = resolve })
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderNavigablePage()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Go to current folder' }))
    expect(await screen.findByText('current.txt')).toBeInTheDocument()
    finishOldFolders(ok({} as InternalAxiosRequestConfig, []))
    finishOldFiles(ok({} as InternalAxiosRequestConfig, [file(11, 'late-old.txt', 1)]))
    await waitFor(() => expect(screen.queryByText('late-old.txt')).not.toBeInTheDocument())
    expect(screen.getByText('current.txt')).toBeInTheDocument()
  })

  it('covers folder rename, move, and delete component paths', async () => {
    let folders = [folder(7, 'Project', null), folder(8, 'Archive', null)]
    const mutations: Array<{ url?: string; method?: string; data?: unknown }> = []
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders' && config.method === 'get') return ok(config, folders)
      if (config.url === '/files') return ok(config, [])
      mutations.push({ url: config.url, method: config.method, data: config.data ? JSON.parse(String(config.data)) : undefined })
      if (config.url === '/files/folders/7' && config.method === 'delete') folders = folders.filter((item) => item.id !== 7)
      return ok(config, {})
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'Project', 'Переименовать')
    await user.clear(screen.getByLabelText('Новое название'))
    await user.type(screen.getByLabelText('Новое название'), 'Renamed project')
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    await waitFor(() => expect(mutations).toHaveLength(1))
    await chooseAction(user, 'Project', 'Переместить')
    await waitFor(() => expect(screen.getByLabelText('Папка назначения')).toBeEnabled())
    await user.selectOptions(screen.getByLabelText('Папка назначения'), '8')
    await user.click(screen.getByRole('button', { name: 'Переместить' }))
    await waitFor(() => expect(mutations).toHaveLength(2))
    await chooseAction(user, 'Project', 'В корзину')
    await user.click(screen.getByRole('button', { name: 'Переместить в корзину' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument())
    expect(mutations).toEqual(expect.arrayContaining([
      { url: '/files/folders/7', method: 'patch', data: { name: 'Renamed project' } },
      { url: '/files/folders/7', method: 'patch', data: { parentId: 8 } },
      { url: '/files/folders/7', method: 'delete', data: undefined },
    ]))
  })

  it('keeps a successfully removed item absent when the refetch fails', async () => {
    let deleted = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') {
        if (deleted) throw serverError(config)
        return ok(config, [file(11, 'remove-me.txt', 1)])
      }
      if (config.url === '/files/11' && config.method === 'delete') { deleted = true; return ok(config, {}) }
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'remove-me.txt', 'В корзину')
    await user.click(screen.getByRole('button', { name: 'Переместить в корзину' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выполнить операцию')
    expect(screen.queryByText('remove-me.txt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })

  it('keeps the item stable and safely reports a 401 mutation', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') return ok(config, [file(11, 'report.txt', 1)])
      throw responseFailure(config, 401, 'raw token failure')
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'report.txt', 'Переименовать')
    await user.clear(screen.getByLabelText('Новое название'))
    await user.type(screen.getByLabelText('Новое название'), 'renamed.txt')
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Сессия истекла')
    expect(screen.getByRole('button', { name: 'report.txt' })).toBeInTheDocument()
    expect(screen.queryByText('raw token failure')).not.toBeInTheDocument()
  })
  it('returns focus to pointer openers when Safari does not focus clicked buttons', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, config.url === '/files' ? [file(11, 'pointer.txt', 1)] : [])
    renderPage('/files')
    const preview = await screen.findByRole('button', { name: 'pointer.txt' })
    preview.click()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(preview).toHaveFocus()
    const create = screen.getByRole('button', { name: 'Новая папка' })
    create.click()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(create).toHaveFocus()
  })

  it('supports keyboard menus and restores focus after cancelling a dialog', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, config.url === '/files' ? [file(11, 'keyboard.txt', 1)] : [])
    renderPage('/files')
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'Действия: keyboard.txt' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Просмотр' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'В корзину' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await chooseAction(user, 'keyboard.txt', 'Переименовать')
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('shows complete metadata in tile mode and does not delete on cancel', async () => {
    let mutations = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.method !== 'get') mutations += 1
      return ok(config, config.url === '/files' ? [file(11, 'retained.txt', 2048)] : [])
    }
    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByText('retained.txt')
    await user.click(screen.getByRole('button', { name: 'Плитка' }))
    expect(screen.getByRole('button', { name: 'Плитка' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('table')).toHaveClass('directory-grid')
    const row = screen.getByRole('button', { name: 'retained.txt' }).closest('tr')!
    expect(within(row).getByText('Размер:')).toBeInTheDocument()
    expect(row).toHaveTextContent('2 КБ')
    await chooseAction(user, 'retained.txt', 'В корзину')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(mutations).toBe(0)
    expect(screen.getByRole('button', { name: 'retained.txt' })).toBeInTheDocument()
  })

  it('allows closing a pending create dialog without allowing a duplicate request', async () => {
    let completeCreate!: () => void
    let createCalls = 0
    let created = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders' && config.method === 'get') return ok(config, created ? [folder(8, 'Pending folder', null)] : [])
      if (config.url === '/files') return ok(config, [])
      if (config.url === '/files/folders' && config.method === 'post') {
        createCalls += 1
        return await new Promise<AxiosResponse>((resolve) => { completeCreate = () => { created = true; resolve(createdResponse(config, {})) } })
      }
      throw new Error(`Unexpected request: ${config.url}`)
    }
    renderPage('/files')
    const user = userEvent.setup()
    await screen.findByText('В этой папке пока пусто')
    const trigger = screen.getByRole('button', { name: 'Новая папка' })
    await user.click(trigger)
    await user.type(screen.getByLabelText('Название папки'), 'Pending folder')
    await user.click(screen.getByRole('button', { name: 'Создать папку' }))
    expect(createCalls).toBe(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Создание папки продолжается')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    await user.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createCalls).toBe(1)
    completeCreate()
    expect(await screen.findByRole('button', { name: 'Pending folder' })).toBeInTheDocument()
    expect(trigger).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows an API conflict after correcting a local rename validation error', async () => {
    let mutations = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') return ok(config, [file(11, 'rename.txt', 1)])
      mutations += 1
      throw responseFailure(config, 409, 'Already exists')
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'rename.txt', 'Переименовать')
    const input = screen.getByLabelText('Новое название')
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Введите название от 1 до 255 символов')
    expect(mutations).toBe(0)
    await user.type(input, 'existing.txt')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Объект с таким названием уже существует')
    expect(mutations).toBe(1)
  })

  it('allows closing a pending rename and clears its late failure before a new action', async () => {
    let failRename!: () => void
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/folders') return ok(config, [])
      if (config.url === '/files') return ok(config, [file(11, 'pending.txt', 1)])
      return await new Promise<AxiosResponse>((_resolve, reject) => { failRename = () => reject(responseFailure(config, 409)) })
    }
    renderPage('/files')
    const user = userEvent.setup()
    await chooseAction(user, 'pending.txt', 'Переименовать')
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    await user.click(screen.getAllByRole('button', { name: 'Закрыть' })[0])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Операция продолжается')
    const trigger = screen.getByRole('button', { name: 'Действия: pending.txt' })
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    await user.click(trigger)
    await user.keyboard('{ArrowDown}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    failRename()
    expect(await screen.findByRole('alert')).toHaveTextContent('Объект с таким названием уже существует')
    await chooseAction(user, 'pending.txt', 'Переименовать')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

})

async function chooseAction(user: ReturnType<typeof userEvent.setup>, name: string, action: string) {
  await user.click(await screen.findByRole('button', { name: `Действия: ${name}` }))
  await user.click(screen.getByRole('menuitem', { name: action }))
}

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

function renderNavigablePage() {
  function Navigation() {
    const navigate = useNavigate()
    return <button onClick={() => navigate('/files/folders/7')} type="button">Go to current folder</button>
  }
  return render(
    <MemoryRouter initialEntries={['/files']}>
      <Navigation />
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

const createdResponse = created

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
