import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { apiClient, sessionClient } from '../api/client'
import { SessionProvider } from '../auth/SessionContext'
import { tokenStorage } from '../auth/tokenStorage'
import type { SearchFile, SearchFolder, SearchPage } from './searchTypes'

const apiAdapter = apiClient.defaults.adapter
const refreshAdapter = sessionClient.defaults.adapter
let calls: InternalAxiosRequestConfig[]
let handle: (config: InternalAxiosRequestConfig) => AxiosResponse | Promise<AxiosResponse>

beforeEach(() => {
  calls = []
  tokenStorage.clear()
  tokenStorage.set({ accessToken: 'initial', refreshToken: 'test-refresh' })
  sessionClient.defaults.adapter = async (config) => ok(config, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
  handle = (config) => ok(config, emptyPage())
  apiClient.defaults.adapter = async (config) => {
    calls.push(config)
    if (config.url === '/users/me') return ok(config, { id: 1, name: 'Owner', email: 'owner@example.test', isActive: true, storageQuota: '10000', storageUsed: '0' })
    if (config.url === '/uploads/sessions' || config.url === '/files' || config.url === '/files/folders') return ok(config, [])
    return handle(config)
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  tokenStorage.clear()
  apiClient.defaults.adapter = apiAdapter
  sessionClient.defaults.adapter = refreshAdapter
  vi.restoreAllMocks()
})

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>История назад</button></>
}

function renderSearch(path = '/files/search') {
  return render(<MemoryRouter initialEntries={[path]}><SessionProvider><LocationProbe /><App /></SessionProvider></MemoryRouter>)
}

function searches() { return calls.filter(call => call.url === '/files/search') }

describe('GlobalSearchPage through authenticated App and API client', () => {
  it('submits explicitly, trims into URL and does not query on keystrokes', async () => {
    handle = config => ok(config, { ...emptyPage(), files: [file(11, 'report.txt')] })
    renderSearch()
    const user = userEvent.setup()
    const input = await screen.findByRole('searchbox', { name: 'Название файла или папки' })
    await user.type(input, '  report  ')
    expect(searches()).toHaveLength(0)
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: 'report.txt' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/files/search?q=report')
    expect(searches()).toHaveLength(1)
    expect(searches()[0].params).toEqual({ q: 'report', limit: 20, offset: 0 })
    expect(searches()[0].headers.Authorization).toBe('Bearer fresh-access')
    await user.type(input, ' more')
    expect(searches()).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
  })

  it('validates a one-character draft locally and preserves keyboard focus', async () => {
    renderSearch()
    const user = userEvent.setup()
    const input = await screen.findByRole('searchbox', { name: 'Название файла или папки' })
    await user.type(input, 'x{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Введите не меньше двух символов')
    expect(input).toHaveFocus()
    expect(searches()).toHaveLength(0)
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('')
  })

  it('paginates a mixed twenty-result page in server order and restores Back without another search', async () => {
    handle = config => ok(config, Number(config.params?.offset) === 20
      ? { ...emptyPage(20), files: [file(99, 'report-last.txt')] }
      : { ...emptyPage(), folders: Array.from({ length: 10 }, (_, index) => folder(index + 1, `report-folder-${index}`)), files: Array.from({ length: 10 }, (_, index) => file(index + 20, `report-file-${index}.txt`)), hasMore: true })
    renderSearch('/files/search?q=report')
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'report-file-9.txt' })
    expect([...document.querySelectorAll('[data-search-key]')].map(row => row.getAttribute('data-search-key'))).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `folder:${index + 1}`), ...Array.from({ length: 10 }, (_, index) => `file:${index + 20}`),
    ])
    expect(screen.getByText('1–20')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Дальше' }))
    expect(await screen.findByRole('button', { name: 'report-last.txt' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('q=report&offset=20')
    expect(screen.getByRole('button', { name: 'Дальше' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'История назад' }))
    expect(await screen.findByRole('button', { name: 'report-file-9.txt' })).toBeInTheDocument()
    expect(searches()).toHaveLength(2)
    expect(screen.getByTestId('location')).toHaveTextContent('/files/search?q=report')
  })

  it('stops pagination at the backend offset ceiling even with hasMore', async () => {
    handle = config => ok(config, { ...emptyPage(10000), files: [file(11, 'report.txt')], hasMore: true })
    renderSearch('/files/search?q=report&offset=10000')
    await screen.findByRole('button', { name: 'report.txt' })
    expect(screen.getByRole('button', { name: 'Дальше' })).toBeDisabled()
    expect(screen.getByText('Слишком много совпадений. Уточните название.')).toBeInTheDocument()
    expect(searches()[0].params.offset).toBe(10000)
  })

  it.each(['q=ab&q=cd', 'q[x]=ab', 'q=report&offset=10001', 'q=report&limit=50'])(
    'rejects malformed URL %s without an API search', async (query) => {
      renderSearch(`/files/search?${query}`)
      expect(await screen.findByRole('alert')).toHaveTextContent('Некорректный адрес поиска')
      expect(searches()).toHaveLength(0)
    },
  )

  it('renders names and highlight as text rather than HTML', async () => {
    const dangerous = '<img src=x onerror=alert(1)>report.txt'
    handle = config => ok(config, { ...emptyPage(), files: [file(11, dangerous)] })
    renderSearch('/files/search?q=report')
    const name = await screen.findByRole('button', { name: dangerous })
    expect(name.querySelector('mark')).toHaveTextContent('report')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(name).toHaveTextContent(dangerous)
  })

  it('opens existing preview from a narrow search DTO and restores trigger focus on Escape', async () => {
    handle = config => ok(config, config.url === '/previews/11' ? { type: 'text', content: 'actual preview payload', mimeType: 'text/plain' } : { ...emptyPage(), files: [file(11, 'report.txt')] })
    renderSearch('/files/search?q=report')
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'report.txt' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Просмотр: report.txt' })
    expect(await within(dialog).findByText('actual preview payload')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Закрыть просмотр' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(calls.filter(call => call.url === '/previews/11')).toHaveLength(1)
  })

  it('opens a found folder with its folder id rather than its sharing mirror id', async () => {
    handle = config => config.url === '/files/folders/7'
      ? ok(config, folder(7, 'report-folder'))
      : ok(config, { ...emptyPage(), folders: [folder(7, 'report-folder')] })
    renderSearch('/files/search?q=report')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'report-folder' }))
    expect(await screen.findByRole('heading', { name: 'report-folder' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/files/folders/7')
    expect(calls.some(call => call.url === '/files/folders/7')).toBe(true)
    expect(calls.some(call => call.url === '/files/folders/1007')).toBe(false)
  })

  it('loads a real full path only for the explicitly selected result', async () => {
    handle = config => {
      if (config.url === '/files/folders/7') return ok(config, { ...folder(7, 'Child'), parentId: 3 })
      if (config.url === '/files/folders/3') return ok(config, folder(3, 'Parent'))
      return ok(config, { ...emptyPage(), files: [file(11, 'report.txt', 7), file(12, 'report-other.txt', 8)] })
    }
    renderSearch('/files/search?q=report')
    const user = userEvent.setup()
    const pathButton = await screen.findByRole('button', { name: 'Путь: report.txt' })
    expect(calls.filter(call => /^\/files\/folders\//.test(call.url ?? ''))).toHaveLength(0)
    await user.click(pathButton)
    const path = await screen.findByRole('navigation', { name: 'Путь к найденному объекту' })
    expect(path).toHaveTextContent('Мои файлы/Parent/Child/report.txt')
    expect(within(path).getByRole('link', { name: 'Child' })).toHaveAttribute('href', '/files/folders/7')
    expect(calls.filter(call => /^\/files\/folders\//.test(call.url ?? '')).map(call => call.url)).toEqual(['/files/folders/7', '/files/folders/3'])
    expect(calls.some(call => call.url === '/files/folders/8')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Закрыть расположение' }))
    await user.click(pathButton)
    await screen.findByRole('navigation', { name: 'Путь к найденному объекту' })
    expect(calls.filter(call => /^\/files\/folders\//.test(call.url ?? ''))).toHaveLength(2)
  })

  it.each([[400, 'Проверьте поисковый запрос'], [503, 'Поиск сейчас недоступен']])(
    'shows safe HTTP %s feedback and preserves the query', async (status, title) => {
      handle = config => { throw failure(config, status, 'private /srv/storage-path and SQL details') }
      renderSearch('/files/search?q=report')
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(title)
      expect(alert).not.toHaveTextContent('storage-path')
      expect(screen.getByRole('searchbox')).toHaveValue('report')
      expect(searches()).toHaveLength(1)
      const user = userEvent.setup()
      if (status === 400) {
        await user.click(screen.getByRole('button', { name: 'Изменить запрос' }))
        expect(screen.getByRole('searchbox')).toHaveFocus()
        expect(searches()).toHaveLength(1)
      } else {
        handle = config => ok(config, emptyPage())
        await user.click(screen.getByRole('button', { name: 'Повторить' }))
        expect(await screen.findByRole('heading', { name: 'Ничего не найдено' })).toBeInTheDocument()
        expect(searches()).toHaveLength(2)
      }
    },
  )

  it('honors Retry-After without polling or exposing raw 429 text', async () => {
    handle = config => { throw failure(config, 429, 'private limiter internals', '30') }
    renderSearch('/files/search?q=report')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Поиск временно ограничен')
    expect(alert).not.toHaveTextContent('private limiter')
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Найти' })).toBeDisabled()
    expect(searches()).toHaveLength(1)
  })

  it('preserves a failed query offline and retries only after an explicit action', async () => {
    handle = config => { throw new AxiosError('private network diagnostic', undefined, config) }
    renderSearch('/files/search?q=report')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Нет связи с сервером')
    expect(alert).not.toHaveTextContent('private network diagnostic')
    expect(screen.getByRole('searchbox')).toHaveValue('report')
    expect(searches()).toHaveLength(1)
    handle = config => ok(config, { ...emptyPage(), files: [file(11, 'report.txt')] })
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('button', { name: 'report.txt' })).toBeInTheDocument()
    expect(searches()).toHaveLength(2)
  })

  it('uses the existing 401 refresh/expiry flow and removes search results on logout', async () => {
    let refreshCalls = 0
    sessionClient.defaults.adapter = async config => {
      refreshCalls += 1
      if (refreshCalls === 1) return ok(config, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
      throw failure(config, 401, 'private rejected refresh')
    }
    handle = config => { throw failure(config, 401, 'private search JWT details') }
    renderSearch('/files/search?q=report')
    expect(await screen.findByRole('heading', { name: 'Войти' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Результаты для «report»' })).not.toBeInTheDocument()
    expect(screen.queryByText('private search JWT details')).not.toBeInTheDocument()
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(refreshCalls).toBe(2)
  })
})

function emptyPage(offset = 0): SearchPage { return { files: [], folders: [], limit: 20, offset, hasMore: false } }
function file(id: number, name: string, parentId: number | null = null): SearchFile {
  return { id, name, parentId, size: '2048', mimeType: 'text/plain', isStarred: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function folder(id: number, name: string): SearchFolder {
  return { id, name, parentId: null, shareFileId: id + 1000, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}
function failure(config: InternalAxiosRequestConfig, status: number, message: string, retryAfter?: string) {
  return new AxiosError('failed', undefined, config, undefined, { config, status, statusText: 'Error', headers: new AxiosHeaders(retryAfter ? { 'Retry-After': retryAfter } : {}), data: { statusCode: status, message } })
}
