import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { apiClient, sessionClient } from '../api/client'
import { SessionProvider } from '../auth/SessionContext'
import { tokenStorage } from '../auth/tokenStorage'
import type { SearchPage } from './searchTypes'

const originalApi = apiClient.defaults.adapter
const originalRefresh = sessionClient.defaults.adapter
let calls: InternalAxiosRequestConfig[]
let discoveredSessions: unknown[]
let searchResult: SearchPage
let filePresent: boolean

beforeEach(() => {
  localStorage.clear()
  tokenStorage.clear()
  tokenStorage.set({ accessToken: 'initial', refreshToken: 'refresh-token' })
  calls = []
  discoveredSessions = []
  searchResult = { files: [], folders: [], offset: 0, limit: 20, hasMore: false }
  filePresent = true
  sessionClient.defaults.adapter = async config => ok(config, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
  apiClient.defaults.adapter = async config => {
    calls.push(config)
    if (config.url === '/users/me') return ok(config, { id: 1, name: 'Owner', email: 'owner@example.test', isActive: true, storageQuota: '10000', storageUsed: '0' })
    if (config.url === '/auth/login') return ok(config, { accessToken: 'login-access', refreshToken: 'login-refresh' })
    if (config.url === '/uploads/sessions') return ok(config, discoveredSessions)
    if (config.url === '/files/search') return ok(config, { ...searchResult, offset: Number(config.params?.offset ?? 0) })
    if (config.url === '/files/folders/7') return ok(config, folder())
    if (config.url === '/files/folders') return ok(config, config.params?.parentId ? [] : [folder()])
    if (config.url === '/files') return ok(config, config.params?.parentId === 7 && filePresent ? [file()] : [])
    if (config.url === '/files/storage-info') return ok(config, { storageUsed: '0', storageQuota: '10000', fileCount: 0, folderCount: 1 })
    if (config.url === '/updates/access') return ok(config, { admin: false })
    throw new Error(`Unexpected request ${config.method} ${config.url}`)
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  if (!HTMLElement.prototype.scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  tokenStorage.clear()
  apiClient.defaults.adapter = originalApi
  sessionClient.defaults.adapter = originalRefresh
  vi.restoreAllMocks()
})

function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="route">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>История назад</button></>
}
function renderWorkspace(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><SessionProvider><NavigationProbe /><App /></SessionProvider></MemoryRouter>)
}

describe('global search in the shared authenticated workspace', () => {
  it('preserves deep-search query and page through an anonymous login roundtrip', async () => {
    tokenStorage.clear()
    searchResult.files = [file()]
    renderWorkspace('/files/search?q=report&offset=40')
    const user = userEvent.setup()
    expect(await screen.findByRole('heading', { name: 'Войти' })).toBeInTheDocument()
    expect(calls.some(call => call.url === '/files/search')).toBe(false)
    await user.type(screen.getByLabelText('Электронная почта'), 'owner@example.test')
    await user.type(screen.getByLabelText('Пароль'), 'test-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'report.txt' })).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('/files/search?q=report&offset=40')
    expect(calls.find(call => call.url === '/files/search')?.params).toEqual({ q: 'report', limit: 20, offset: 40 })
    expect(calls.find(call => call.url === '/auth/login')?.data).toBe(JSON.stringify({ email: 'owner@example.test', password: 'test-password' }))
  })

  it('keeps the real discovered upload queue mounted and visible across directory → search → folder → Back', async () => {
    discoveredSessions = [{ uploadId: '00000000-0000-4000-8000-000000000001', filename: 'paused-upload.bin', totalSize: 2048, chunkSize: 1024, totalChunks: 2, uploadedSize: 1024, parentId: null, status: 'uploading', expiresAt: '2027-01-01T00:00:00Z' }]
    searchResult.folders = [folder()]
    renderWorkspace('/files')
    const user = userEvent.setup()
    const manager = await screen.findByLabelText('Загрузки')
    expect(within(manager).getByText('paused-upload.bin')).toBeInTheDocument()
    await user.click(within(manager).getByRole('button', { name: /Загрузки.*Свернуть/ }))
    const collapsed = within(manager).getByRole('button', { name: /Загрузки.*Развернуть/ })
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Поиск во всех файлах' }))
    const input = await screen.findByRole('searchbox', { name: 'Название файла или папки' })
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    await user.type(input, 'report{Enter}')
    await user.click(await screen.findByRole('button', { name: 'report-folder' }))
    expect(await screen.findByRole('heading', { name: 'report-folder' })).toBeInTheDocument()
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'История назад' }))
    expect(await screen.findByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    expect(calls.filter(call => call.url === '/uploads/sessions')).toHaveLength(1)
    expect(calls.some(call => call.method === 'delete' || call.url?.includes('/chunks'))).toBe(false)
    await user.click(collapsed)
    expect(within(manager).getByText('paused-upload.bin')).toBeVisible()
    expect(within(manager).getByText('Для докачки выберите исходный файл')).toBeVisible()
  })

  it('focuses global search with Ctrl+K from a folder while leaving input and modal shortcuts alone', async () => {
    renderWorkspace('/files/folders/7')
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'report-folder' })
    const local = screen.getByRole('searchbox', { name: 'Поиск в текущей папке' })
    local.focus()
    fireEvent.keyDown(local, { key: 'k', ctrlKey: true })
    expect(screen.getByTestId('route')).toHaveTextContent('/files/folders/7')
    expect(local).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Открыть аккаунт: Owner' }))
    const dialog = await screen.findByRole('dialog', { name: 'Аккаунт и хранилище' })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('/files/folders/7')
    await user.keyboard('{Escape}')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const global = await screen.findByRole('searchbox', { name: 'Название файла или папки' })
    expect(screen.getByTestId('route')).toHaveTextContent('/files/search')
    expect(global).toHaveFocus()
    expect(screen.getByRole('link', { name: 'К исходной папке' })).toHaveAttribute('href', '/files/folders/7')
  })

  it.each([true, false])('shows a found file in its folder with present=%s, handling a stale result explicitly', async present => {
    filePresent = present
    searchResult.files = [file()]
    renderWorkspace('/files/search?q=report')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Действия: report.txt' }))
    await user.click(screen.getByRole('menuitem', { name: 'Показать в папке' }))
    expect(await screen.findByRole('heading', { name: 'report-folder' })).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('/files/folders/7')
    if (present) {
      const selected = await screen.findByRole('checkbox', { name: 'Выбрать report.txt' })
      await waitFor(() => expect(selected).toBeChecked())
      expect(selected.closest('tr')).toHaveClass('is-selected')
      expect(screen.getByRole('button', { name: 'report.txt' })).toHaveFocus()
      expect(screen.getByText('Найденный объект выделен в папке.')).toBeInTheDocument()
    } else {
      expect(screen.queryByRole('checkbox', { name: 'Выбрать report.txt' })).not.toBeInTheDocument()
      expect(screen.getByText('Расположение изменилось или объект больше недоступен. Повторите поиск.')).toBeInTheDocument()
    }
    await user.click(screen.getByRole('link', { name: 'Вернуться к результатам поиска' }))
    expect(await screen.findByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
    expect(calls.filter(call => call.url === '/files/search')).toHaveLength(1)
  })
})

function file() {
  return { id: 11, name: 'report.txt', parentId: 7, size: '2048', mimeType: 'text/plain', isStarred: false, isDeleted: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function folder() {
  return { id: 7, name: 'report-folder', parentId: null, shareFileId: 1007, isDeleted: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}
