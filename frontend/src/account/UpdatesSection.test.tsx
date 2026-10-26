import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
