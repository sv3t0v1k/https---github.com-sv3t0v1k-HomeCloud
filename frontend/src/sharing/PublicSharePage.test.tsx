import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/errors'
import { PublicSharePage } from './PublicSharePage'
import * as api from './publicShareApi'
vi.mock('./publicShareApi', () => ({ getPublicShare: vi.fn(), verifyPublicShare: vi.fn(), getSharedChildren: vi.fn(), downloadPublicShare: vi.fn() }))
function page() { return render(<MemoryRouter initialEntries={['/share/token']}><Routes><Route path="/share/:token" element={<PublicSharePage />} /></Routes></MemoryRouter>) }
beforeEach(() => { vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: false, requiresPassword: false, expiresAt: null }); vi.mocked(api.downloadPublicShare).mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
describe('PublicSharePage', () => {
  it('renders authoritative filename, canonical size, exact footer and no unsupported viewer', async () => {
    const name = 'очень-длинное-имя-'.repeat(12) + '.pdf'
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: false, requiresPassword: false, expiresAt: null, resource: { name, size: '1825361101', mimeType: 'application/pdf' } })
    page()
    expect(await screen.findByRole('heading', { level: 1, name })).toHaveAttribute('title', name)
    expect(screen.getByText(/1,7 ГБ/)).toBeInTheDocument()
    expect(screen.getByText('Безопасный доступ через HomeCloud')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Просмотр/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скачать файл' })).toBeEnabled()
  })
  it('replaces protected state with metadata only after successful unlock', async () => {
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: false, requiresPassword: true, expiresAt: null })
    vi.mocked(api.verifyPublicShare).mockResolvedValue({ success: true, resource: { name: 'секрет.pdf', size: 12698, mimeType: 'application/pdf' } })
    page()
    expect(await screen.findByRole('heading', { name: 'Доступ защищён паролем' })).toBeInTheDocument()
    expect(screen.queryByText('секрет.pdf')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Пароль ссылки'), 'fixture')
    await userEvent.click(screen.getByRole('button', { name: 'Открыть доступ' }))
    expect(await screen.findByRole('heading', { name: 'секрет.pdf' })).toBeInTheDocument()
    expect(screen.getByText(/12,4 КБ/)).toBeInTheDocument()
  })
  it.each(['expired', 'revoked', 'invalid'])('honestly uses the same unavailable state for %s (API 404)', async () => {
    vi.mocked(api.getPublicShare).mockRejectedValue(new ApiError('private reason', 'unknown', 404))
    page()
    expect(await screen.findByRole('alert')).toHaveTextContent('Ссылка недоступна')
    expect(screen.queryByRole('button', { name: 'Скачать файл' })).not.toBeInTheDocument()
    expect(screen.getByText('Безопасный доступ через HomeCloud')).toBeInTheDocument()
  })
  it('keeps resource and a retryable download action after a download failure', async () => {
    vi.mocked(api.downloadPublicShare).mockRejectedValueOnce(new ApiError('secret path', 'server', 500))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать файл' }))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('secret path')
    expect(screen.getByRole('button', { name: 'Скачать файл' })).toBeEnabled()
  })
  it('downloads anonymously without requiring an account', async () => {
    page(); await userEvent.click(await screen.findByRole('button', { name: 'Скачать файл' }))
    expect(api.downloadPublicShare).toHaveBeenCalledWith('token', '', undefined, undefined, expect.any(AbortSignal))
    expect(await screen.findByRole('status')).toHaveTextContent('Передано браузеру')
  })
  it('verifies password, handles incorrect input and prevents duplicate requests', async () => {
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: false, requiresPassword: true, expiresAt: null })
    vi.mocked(api.verifyPublicShare).mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true })
    page(); await userEvent.type(await screen.findByLabelText('Пароль ссылки'), 'secret')
    await userEvent.click(screen.getByRole('button', { name: 'Открыть доступ' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный пароль')
    const form = screen.getByLabelText('Пароль ссылки').closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    await screen.findByRole('button', { name: 'Скачать файл' })
    expect(api.verifyPublicShare).toHaveBeenCalledTimes(2)
    expect(screen.queryByLabelText('Пароль ссылки')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Скачать файл' }))
    expect(api.downloadPublicShare).toHaveBeenCalledWith('token', 'secret', undefined, undefined, expect.any(AbortSignal))
  })
  it('navigates folder children, pages, breadcrumbs and downloads child or ZIP', async () => {
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 10, isFolder: true, requiresPassword: false, expiresAt: null })
    vi.mocked(api.getSharedChildren).mockImplementation(async (_token, _password, parent, offset = 0) => ({ parentId: parent || 10, items: parent ? [{ id: 4, kind: 'file', name: 'child.txt', size: 4 }] : offset ? [] : [{ id: 20, kind: 'folder', name: 'Docs', size: null }], offset, limit: 50, hasMore: !parent && offset === 0 }))
    page(); await userEvent.click(await screen.findByRole('button', { name: 'Открыть Docs' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать child.txt' }))
    expect(api.downloadPublicShare).toHaveBeenCalledWith('token', '', 4, 'child.txt', expect.any(AbortSignal))
    await userEvent.click(screen.getByRole('button', { name: 'Общая папка' }))
    await screen.findByRole('button', { name: 'Открыть Docs' })
    await userEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    expect(await screen.findByText('Папка пуста.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Следующая страница' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Предыдущая страница' }))
    await screen.findByRole('button', { name: 'Открыть Docs' })
    await userEvent.click(screen.getByRole('button', { name: 'Скачать папку ZIP' }))
    expect(api.downloadPublicShare).toHaveBeenCalledWith('token', '', undefined, undefined, expect.any(AbortSignal))
  })
  it('reports revoked links without leaking backend details and offers retry', async () => {
    vi.mocked(api.getPublicShare).mockRejectedValueOnce(new ApiError('private detail', 'unknown', 404)).mockResolvedValueOnce({ fileId: 1, isFolder: false, requiresPassword: false, expiresAt: null })
    page(); expect(await screen.findByRole('alert')).toHaveTextContent('Ссылка недоступна')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private detail')
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await screen.findByRole('button', { name: 'Скачать файл' })
  })
  it('remounts token-scoped folder state without sending the old password to a new token', async () => {
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: true, requiresPassword: true, expiresAt: null })
    vi.mocked(api.verifyPublicShare).mockResolvedValue({ success: true })
    vi.mocked(api.getSharedChildren).mockResolvedValue({ parentId: 1, items: [], offset: 0, limit: 50, hasMore: false })
    render(<MemoryRouter initialEntries={['/share/token']}><RouteSwitch /><Routes><Route path="/share/:token" element={<PublicSharePage />} /></Routes></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Пароль ссылки'), 'password-for-A')
    await userEvent.click(screen.getByRole('button', { name: 'Открыть доступ' }))
    await screen.findByText('Папка пуста.')
    expect(api.getSharedChildren).toHaveBeenCalledWith('token', 'password-for-A', undefined, 0, expect.any(AbortSignal))
    await userEvent.click(screen.getByRole('button', { name: 'Другая ссылка' }))
    await screen.findByLabelText('Пароль ссылки')
    expect(vi.mocked(api.getSharedChildren).mock.calls.some(([token, password]) => token === 'other-token' && password === 'password-for-A')).toBe(false)
    expect(vi.mocked(api.getSharedChildren).mock.calls.filter(([token]) => token === 'other-token')).toHaveLength(0)
  })
  it('aborts old password verification and never unlocks a different token', async () => {
    vi.mocked(api.getPublicShare).mockResolvedValue({ fileId: 1, isFolder: false, requiresPassword: true, expiresAt: null })
    let resolve!: (value: { success: boolean }) => void
    vi.mocked(api.verifyPublicShare).mockReturnValue(new Promise((done) => { resolve = done }))
    render(<MemoryRouter initialEntries={['/share/token']}><RouteSwitch /><Routes><Route path="/share/:token" element={<PublicSharePage />} /></Routes></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Пароль ссылки'), 'old-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Открыть доступ' }))
    const oldSignal = vi.mocked(api.verifyPublicShare).mock.calls[0][2]!
    await userEvent.click(screen.getByRole('button', { name: 'Другая ссылка' }))
    expect(oldSignal.aborted).toBe(true)
    await screen.findByRole('button', { name: 'Открыть доступ' })
    await act(async () => resolve({ success: true }))
    expect(screen.getByLabelText('Пароль ссылки')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Скачать файл' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Открыть доступ' })).toBeEnabled()
  })
  it('aborts an old download and suppresses its completion notice on a different token', async () => {
    let resolve!: () => void
    vi.mocked(api.downloadPublicShare).mockReturnValue(new Promise((done) => { resolve = done }))
    render(<MemoryRouter initialEntries={['/share/token']}><RouteSwitch /><Routes><Route path="/share/:token" element={<PublicSharePage />} /></Routes></MemoryRouter>)
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать файл' }))
    const oldSignal = vi.mocked(api.downloadPublicShare).mock.calls[0][4]!
    await userEvent.click(screen.getByRole('button', { name: 'Другая ссылка' }))
    expect(oldSignal.aborted).toBe(true)
    await screen.findByRole('button', { name: 'Скачать файл' })
    await act(async () => resolve())
    expect(screen.queryByText('Скачивание подготовлено.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скачать файл' })).toBeEnabled()
  })
  it('blocks duplicate pending downloads and reports failure', async () => {
    let reject!: (cause: unknown) => void
    vi.mocked(api.downloadPublicShare).mockReturnValue(new Promise((_resolve, rejectFn) => { reject = rejectFn }))
    page(); const button = await screen.findByRole('button', { name: 'Скачать файл' })
    fireEvent.click(button); fireEvent.click(button)
    expect(api.downloadPublicShare).toHaveBeenCalledTimes(1)
    reject(new ApiError('private', 'server', 500))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выполнить действие')
    expect(screen.getByRole('button', { name: 'Скачать файл' })).toBeEnabled()
  })
})

function RouteSwitch() { const navigate = useNavigate(); return <button type="button" onClick={() => navigate('/share/other-token')}>Другая ссылка</button> }
