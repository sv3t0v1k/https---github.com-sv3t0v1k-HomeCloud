import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { TrashPage } from './TrashPage'

describe('TrashPage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  beforeEach(() => { apiClient.defaults.adapter = undefined })

  it('lists, restores, and permanently deletes with confirmation and refetch', async () => {
    let files = [file(4, 'old.txt')]
    let folders = [folder(7, 'Old folder')]
    const calls: string[] = []
    apiClient.defaults.adapter = async (config) => {
      calls.push(`${config.method}:${config.url}`)
      if (config.url === '/files/trash') return ok(config, { files, folders })
      if (config.url === '/files/4/restore') { files = []; return ok(config, { message: 'restored' }) }
      if (config.url === '/files/folders/7/permanent') { folders = []; return ok(config, { message: 'deleted' }) }
      throw new Error(`Unexpected ${config.url}`)
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Восстановить old.txt' }))
    await waitFor(() => expect(screen.queryByText('old.txt')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Удалить Old folder навсегда' }))
    expect(screen.getByRole('dialog', { name: 'Удалить «Old folder» навсегда?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Удалить навсегда' }))
    await waitFor(() => expect(screen.getByText('Корзина пуста')).toBeInTheDocument())
    expect(calls).toContain('post:/files/4/restore')
    expect(calls).toContain('delete:/files/folders/7/permanent')
  })

  it('keeps items after a failed mutation and shows only a safe error', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/trash') return ok(config, { files: [file(4, 'old.txt')], folders: [] })
      throw failure(config, 500, '/private/storage/user-secret')
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Восстановить old.txt' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выполнить операцию. Повторите попытку.')
    expect(screen.getByText('old.txt')).toBeInTheDocument()
    expect(screen.queryByText(/private\/storage/)).not.toBeInTheDocument()
  })

  it('suppresses duplicate mutations while one is pending', async () => {
    let restoreCalls = 0
    let finish!: (value: AxiosResponse) => void
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/trash') return ok(config, { files: [file(4, 'old.txt')], folders: [] })
      restoreCalls += 1
      return await new Promise<AxiosResponse>((resolve) => { finish = resolve })
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: 'Восстановить old.txt' })
    await user.dblClick(button)
    expect(restoreCalls).toBe(1)
    finish(ok({} as InternalAxiosRequestConfig, {}))
  })

  it('requires confirmation before emptying trash and then refetches', async () => {
    let files = [file(4, 'old.txt')]
    let emptyCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/trash') return ok(config, { files, folders: [] })
      if (config.url === '/files/empty-trash') { emptyCalls += 1; files = []; return ok(config, {}) }
      throw new Error(`Unexpected ${config.url}`)
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: 'Очистить корзину' })
    act(() => button.click())
    expect(screen.getByRole('dialog', { name: 'Очистить корзину?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(emptyCalls).toBe(0)
    expect(button).toHaveFocus()
    await user.click(button)
    await user.click(screen.getByRole('button', { name: 'Удалить всё навсегда' }))
    expect(await screen.findByText('Корзина пуста')).toBeInTheDocument()
    expect(emptyCalls).toBe(1)
  })

  it('traps confirmation focus, cancels with Escape, and restores the trigger without deleting', async () => {
    const calls: string[] = []
    apiClient.defaults.adapter = async (config) => {
      calls.push(`${config.method}:${config.url}`)
      return ok(config, { files: [file(4, 'old.txt')], folders: [] })
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'Удалить old.txt навсегда' })
    act(() => trigger.click())
    const cancel = screen.getByRole('button', { name: 'Отмена' })
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Удалить навсегда' })).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(calls).toEqual(['get:/files/trash'])
  })

  it('restores a folder through the folder lifecycle endpoint', async () => {
    let folders = [folder(7, 'Old folder')]
    let restoreCalls = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/files/trash') return ok(config, { files: [], folders })
      if (config.url === '/files/folders/7/restore') { restoreCalls += 1; folders = []; return ok(config, {}) }
      throw new Error(`Unexpected ${config.url}`)
    }
    render(<TrashPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Восстановить Old folder' }))
    expect(await screen.findByText('Корзина пуста')).toBeInTheDocument()
    expect(restoreCalls).toBe(1)
  })
})

function file(id: number, name: string) { return { id, name, size: 1, mimeType: 'text/plain', isDeleted: true, isStarred: false, parentId: null, deletedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }
function folder(id: number, name: string) { return { id, name, isDeleted: true, parentId: null, deletedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }
function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse { return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } } }
function failure(config: InternalAxiosRequestConfig, status: number, message: string) { return new AxiosError('failed', undefined, config, undefined, { config, status, statusText: 'Error', headers: new AxiosHeaders(), data: { statusCode: status, message } }) }
