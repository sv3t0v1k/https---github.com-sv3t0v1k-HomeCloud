import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { apiRequest } from '../api/client'
import { UpdatesSection } from './UpdatesSection'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('UpdatesSection', () => {
  it('does not expose the section to an ordinary user', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ admin: false })
    render(<UpdatesSection />)
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('region', { name: 'Обновления' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('shows installed version but does not claim an update when verification fails', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ admin: true }).mockResolvedValueOnce({
      channel: 'test', installed: { version: 'ac1aca1', gitSha: 'ac1aca1'.padEnd(40, '0') },
      available: null, status: 'check_unavailable',
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Проверка сейчас недоступна/)).toBeInTheDocument()
    expect(screen.getByText(/Установленная версия: ac1aca1/)).toBeInTheDocument()
    expect(screen.queryByText(/Доступна проверенная сборка/)).not.toBeInTheDocument()
  })

  it('sends only the verified TEST manifest after confirmation and shows the host result', async () => {
    const hash = 'a'.repeat(64)
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates') return {
        channel: 'test', installed: { version: 'test-old', gitSha: '1'.repeat(40) },
        status: 'available', available: { version: 'test-new', gitSha: '2'.repeat(40),
          manifestSha256: hash, changes: '', compatibility: 'exact-migrations' },
      }
      if (config.url === '/updates/installations/current') return {
        status: 'NO_JOB', manifestSha256: null, phase: null, updatedAt: null,
      }
      if (config.method === 'POST') return {
        status: 'QUEUED', manifestSha256: hash, phase: null, updatedAt: null,
      }
      throw new Error('unexpected request')
    })
    render(<UpdatesSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Установить test-new' }))
    expect(apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }))
    await user.click(screen.getByRole('button', { name: 'Подтвердить установку' }))
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', url: '/updates/installations', data: { manifestSha256: hash },
    })))
    expect(await screen.findByText('Заявка передана хосту.')).toBeInTheDocument()
  })

  it('does not offer installation while the host status needs review', async () => {
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates') return { channel: 'test', installed: null,
        status: 'available', available: { version: 'test-new', gitSha: '2'.repeat(40),
          manifestSha256: 'a'.repeat(64), changes: '', compatibility: 'exact-migrations' } }
      return { status: 'MANUAL_RECOVERY_REQUIRED', manifestSha256: 'a'.repeat(64), phase: 'INSTALLER', updatedAt: 'now' }
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Нужна ручная проверка/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Установить test-new/ })).not.toBeInTheDocument()
  })

  it('refreshes the installed version after the host confirms completion', async () => {
    let checks = 0
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates/installations/current') return {
        status: 'INSTALLED', manifestSha256: 'a'.repeat(64), phase: 'COMPLETE', updatedAt: 'now',
      }
      if (config.url === '/updates') {
        checks += 1
        return { channel: 'test', status: 'current', available: null,
          installed: { version: checks === 1 ? 'test-old' : 'test-new',
            gitSha: (checks === 1 ? '1' : '2').repeat(40) } }
      }
      throw new Error('unexpected request')
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Установленная версия: test-new/)).toBeInTheDocument()
    expect(checks).toBeGreaterThanOrEqual(2)
  })
})
