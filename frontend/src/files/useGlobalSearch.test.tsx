import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tokenStorage } from '../auth/tokenStorage'
import { ApiError } from '../api/errors'
import { searchFiles } from './searchApi'
import type { SearchPage } from './searchTypes'
import { SearchSessionProvider, useGlobalSearch } from './useGlobalSearch'

vi.mock('./searchApi', async (original) => ({ ...await original<typeof import('./searchApi')>(), searchFiles: vi.fn() }))
const search = vi.mocked(searchFiles)

function page(offset = 0, name = 'result'): SearchPage {
  return { files: [{ id: 1, name, parentId: null, size: '1', mimeType: 'text/plain', isStarred: false, createdAt: '', updatedAt: '' }], folders: [], offset, limit: 20, hasMore: false }
}

function Probe({ query, offset = 0 }: { query: string | null; offset?: number }) {
  const result = useGlobalSearch(query, offset)
  return <><span data-testid="status">{result.status}</span><span data-testid="data">{result.data?.files[0]?.name}</span><span data-testid="error">{result.error?.status}</span><span data-testid="cooldown">{result.cooldownUntil}</span><button onClick={result.retry}>Retry</button></>
}

function Session({ owner = 1, children }: { owner?: number; children: ReactNode }) {
  return <SearchSessionProvider ownerId={owner}>{children}</SearchSessionProvider>
}

beforeEach(() => { tokenStorage.clear(); search.mockReset() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('global search session lifecycle', () => {
  it('does not search an idle route and sends one request under StrictMode', async () => {
    search.mockResolvedValue(page())
    const view = render(<StrictMode><Session><Probe query={null} /></Session></StrictMode>)
    expect(search).not.toHaveBeenCalled()
    view.rerender(<StrictMode><Session><Probe query="report" /></Session></StrictMode>)
    expect(await screen.findByTestId('data')).toHaveTextContent('result')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('deduplicates StrictMode initial effects and a repeated retry while pending', async () => {
    let resolve!: (value: SearchPage) => void
    search.mockImplementation(() => new Promise<SearchPage>((done) => { resolve = done }))
    render(<StrictMode><Session><Probe query="report" /></Session></StrictMode>)
    expect(search).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(search).toHaveBeenCalledTimes(1)
    await act(async () => resolve(page()))
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
  })

  it('cancels the old query and ignores its late response', async () => {
    let resolveFirst!: (value: SearchPage) => void
    search.mockImplementationOnce(() => new Promise<SearchPage>((done) => { resolveFirst = done })).mockResolvedValueOnce(page(0, 'new owner result'))
    const view = render(<Session><Probe query="first" /></Session>)
    const firstSignal = search.mock.calls[0][2]!
    view.rerender(<Session><Probe query="second" /></Session>)
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('new owner result'))
    await act(async () => resolveFirst(page(0, 'stale result')))
    expect(screen.getByTestId('data')).not.toHaveTextContent('stale result')
  })

  it('aborts on leaving the search while retaining ready pages for Back', async () => {
    search.mockResolvedValueOnce(page())
    const view = render(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    view.rerender(<Session><Probe query={null} /></Session>)
    view.rerender(<Session><Probe query="report" /></Session>)
    expect(screen.getByTestId('data')).toHaveTextContent('result')
    expect(search).toHaveBeenCalledTimes(1)
    let lastSignal: AbortSignal | undefined
    search.mockImplementation((_q, _o, signal) => { lastSignal = signal; return new Promise<SearchPage>(() => undefined) })
    view.rerender(<Session><Probe query="pending" /></Session>)
    view.rerender(<Session><Probe query={null} /></Session>)
    await act(async () => { await Promise.resolve() })
    expect(lastSignal?.aborted).toBe(true)
  })

  it('expires cached pages after 60 seconds without background requests', async () => {
    let now = 100000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    search.mockResolvedValue(page())
    const view = render(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    now += 61000
    expect(search).toHaveBeenCalledTimes(1)
    view.rerender(<Session><Probe query={null} /></Session>)
    view.rerender(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  })

  it('drops cache on owner/token generation change and hides late old responses', async () => {
    let resolve!: (value: SearchPage) => void
    search.mockImplementationOnce(() => new Promise<SearchPage>((done) => { resolve = done })).mockResolvedValueOnce(page(0, 'second user'))
    const view = render(<Session><Probe query="report" /></Session>)
    const firstSignal = search.mock.calls[0][2]!
    act(() => tokenStorage.clear())
    view.rerender(<Session owner={2}><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('second user'))
    expect(firstSignal.aborted).toBe(true)
    await act(async () => resolve(page(0, 'private first user')))
    expect(screen.getByTestId('data')).not.toHaveTextContent('private first user')
  })

  it('keeps access-token rotation in the same owner boundary but clears a new login generation', async () => {
    tokenStorage.set({ accessToken: 'first-access', refreshToken: 'first-refresh' })
    search.mockResolvedValue(page())
    const view = render(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    act(() => { tokenStorage.setIfCurrent({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }, tokenStorage.getEpoch()) })
    view.rerender(<Session><Probe query="report" /></Session>)
    expect(search).toHaveBeenCalledTimes(1)
    act(() => tokenStorage.set({ accessToken: 'new-login-access', refreshToken: 'new-login-refresh' }))
    view.rerender(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(JSON.stringify(localStorage)).not.toContain('report')
    expect(JSON.stringify(sessionStorage)).not.toContain('report')
  })

  it('cancels a pending request when the shared provider actually unmounts', async () => {
    search.mockImplementation(() => new Promise<SearchPage>(() => undefined))
    const view = render(<Session><Probe query="report" /></Session>)
    const signal = search.mock.calls[0][2]!
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(signal.aborted).toBe(true)
  })

  it('shares 429 cooldown across queries without polling and permits only manual retry', async () => {
    let now = 100000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    search.mockRejectedValueOnce(new ApiError('private raw server text', 'rate-limit', 429, '12')).mockResolvedValueOnce(page())
    const view = render(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('429'))
    expect(screen.getByTestId('cooldown')).toHaveTextContent('112000')
    view.rerender(<Session><Probe query="other" /></Session>)
    expect(search).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(search).toHaveBeenCalledTimes(1)
    now += 13000
    expect(search).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(search).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 503])('does not automatically retry HTTP %s', async (status) => {
    search.mockRejectedValueOnce(new ApiError('server raw details', status === 401 ? 'authentication' : status === 400 ? 'validation' : 'server', status)).mockResolvedValueOnce(page())
    render(<Session><Probe query="report" /></Session>)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(String(status)))
    expect(search).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('evicts old pages beyond the ten-page bound', async () => {
    search.mockImplementation(async (_query, offset) => page(offset))
    const view = render(<Session><Probe query="report" offset={0} /></Session>)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    for (let offset = 20; offset <= 200; offset += 20) {
      view.rerender(<Session><Probe query="report" offset={offset} /></Session>)
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    }
    expect(search).toHaveBeenCalledTimes(11)
    view.rerender(<Session><Probe query="report" offset={0} /></Session>)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(12))
  })
})
