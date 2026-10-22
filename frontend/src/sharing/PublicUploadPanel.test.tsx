import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import { PublicUploadPanel } from './PublicUploadPanel'
vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
vi.mock('../files/wholeSha256', () => ({ hashFileSha256: vi.fn().mockResolvedValue('a'.repeat(64)) }))
const request = vi.mocked(apiRequest)
let calls: AxiosRequestConfig[]
let failCreate: boolean
let failFolder: boolean
let failComplete: boolean
let sequence = 0
let createCount = 0
const sessions = new Map<string, { uploadId: string; filename: string; totalSize: number; chunkSize: number; parentId: number }>()
beforeEach(() => {
  calls = []; failCreate = false; failFolder = false; failComplete = false; createCount = 0; sessions.clear()
  vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, subtle: { digest: async () => new ArrayBuffer(32) } })
  request.mockImplementation(async <T,>(config: AxiosRequestConfig) => {
    calls.push(config)
    if (config.url?.endsWith('/upload-authorizations')) return { proof: 'proof', expiresAt: new Date(Date.now() + 300000).toISOString() } as T
    if (config.url?.endsWith('/folders')) {
      if (failFolder) throw new ApiError('missing', 'authorization', 404)
      return { id: 30, name: 'tree (1)', parentId: config.data.parentId } as T
    }
    if (config.url?.endsWith('/uploads/session')) {
      createCount++
      if (failCreate) throw new ApiError('lost response', 'network')
      const session = { uploadId: String(createCount), ...config.data }; sessions.set(session.uploadId, session)
      return { ...session, totalChunks: 1 } as T
    }
    if (config.url?.endsWith('/chunk')) return {} as T
    if (config.url?.endsWith('/complete')) {
      if (failComplete && sessions.get(config.url.split('/').slice(-2)[0])?.filename === 'failed.txt') throw new ApiError('denied', 'authorization', 403)
      return { id: 70, name: 'actual.txt', parentId: 30 } as T
    }
    if (config.method === 'GET') throw new ApiError('moved', 'unknown', 409)
    throw new Error(`Unexpected ${config.url}`)
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
function panel(parentId = 5) { return render(<PublicUploadPanel token="token" password="" parentId={parentId} targetName="Root" onCommit={() => {}} />) }
async function select(files: File[]) {
  await screen.findByRole('button', { name: 'Загрузить файлы' })
  fireEvent.change(screen.getByLabelText('Выбрать файлы'), { target: { files } })
}
function treeFile(path: string) { const file = new File(['bytes'], path.split('/').slice(-1)[0]!); Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file }

describe('public upload workspace', () => {
  it('uses returned folder ID, freezes target during navigation and confirms actual file name', async () => {
    const view = panel()
    await select([treeFile('tree/deep.txt')])
    view.rerender(<PublicUploadPanel token="token" password="" parentId={99} targetName="Other" onCommit={() => {}} />)
    await screen.findByText(/Всё обнаруженное дерево загружено/)
    expect(calls.find((call) => call.url?.endsWith('/folders'))?.data).toEqual({ name: 'tree', parentId: 5 })
    expect(calls.find((call) => call.url?.endsWith('/uploads/session'))?.data).toMatchObject({ parentId: 30, expectedSha256: 'a'.repeat(64) })
    expect(screen.getByText('Сохранён: actual.txt')).toBeInTheDocument()
    expect(screen.getByText(/Назначение: Root/)).toBeInTheDocument()
    expect(calls.every((call) => call.skipAuth && call.skipRefresh)).toBe(true)
  })
  it('replays an uncertain session create with the same key and exact payload', async () => {
    failCreate = true; panel(); await select([new File(['x'], 'x.txt')])
    await screen.findByText(/Частичный результат/)
    failCreate = false
    fireEvent.click(screen.getByRole('button', { name: 'Повторить неудачные операции' }))
    await screen.findByText(/Всё обнаруженное дерево загружено/)
    const creates = calls.filter((call) => call.url?.endsWith('/uploads/session'))
    expect(creates).toHaveLength(2)
    expect(creates[1].data).toEqual(creates[0].data)
    expect(creates[1].headers).toEqual(creates[0].headers)
    expect(calls.some((call) => call.url === '/uploads/sessions')).toBe(false)
  })
  it('blocks descendants until folder replay succeeds and retains its key', async () => {
    failFolder = true; panel(); await select([treeFile('tree/child.txt')])
    await screen.findByText(/Частичный результат/)
    expect(createCount).toBe(0)
    failFolder = false; fireEvent.click(screen.getByRole('button', { name: 'Повторить неудачные операции' }))
    await screen.findByText(/Всё обнаруженное дерево загружено/)
    const folders = calls.filter((call) => call.url?.endsWith('/folders'))
    expect(folders[1].headers).toEqual(folders[0].headers)
    expect(createCount).toBe(1)
  })
  it('rejects empty files, allows explicit partial completion and a new batch', async () => {
    panel(); await select([new File([], 'empty.txt')])
    await screen.findByText(/Частичный результат/)
    expect(screen.getByRole('alert')).toHaveTextContent('Пустые файлы')
    fireEvent.click(screen.getByRole('button', { name: 'Завершить с частичным результатом' }))
    expect(screen.getByText(/повторный выбор тех же файлов может создать дубликаты/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить завершение задания' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Загрузить файлы' })).toBeEnabled())
    expect(createCount).toBe(0)
  })
  it('rechecks completed receipts before claiming a partial tree has resumed', async () => {
    failComplete = true; panel(); await select([new File(['x'], 'ok.txt'), new File(['y'], 'failed.txt')])
    await screen.findByText(/Частичный результат/)
    failComplete = false
    fireEvent.click(screen.getByRole('button', { name: 'Повторить неудачные операции' }))
    await screen.findByText(/Конфликт операции/)
    expect(screen.queryByText(/Всё обнаруженное дерево загружено/)).not.toBeInTheDocument()
    expect(createCount).toBe(2)
  })
  it('hides writes on readonly capability and distinguishes transport failure', async () => {
    request.mockRejectedValueOnce(new ApiError('readonly', 'authorization', 403))
    panel(); await screen.findByText('Только просмотр и скачивание.')
    expect(screen.queryByRole('button', { name: 'Загрузить файлы' })).not.toBeInTheDocument()
  })
})
