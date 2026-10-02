import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '../api/client'
import { ShareDialog } from './ShareDialog'

describe('ShareDialog', () => {
  beforeEach(() => {
    apiClient.defaults.adapter = undefined
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('creates a protected file share with exact policy fields and never renders the password', async () => {
    const payloads: unknown[] = []
    let shares: unknown[] = []
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get' && config.url === '/sharing') return ok(config, shares)
      if (config.method === 'post' && config.url === '/sharing') {
        payloads.push(JSON.parse(String(config.data)))
        shares = [share(5, 'token-5', 12)]
        return ok(config, shares[0])
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`)
    }

    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    const user = userEvent.setup()
    await screen.findByText('Для этого объекта пока нет ссылок.')
    await user.clear(screen.getByLabelText('Срок действия, дней'))
    await user.type(screen.getByLabelText('Срок действия, дней'), '30')
    await user.type(screen.getByLabelText('Лимит скачиваний (необязательно)'), '4')
    await user.type(screen.getByLabelText('Пароль (необязательно)'), 'secret phrase')
    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }))

    expect(await screen.findByText('Ссылка создана.')).toBeInTheDocument()
    expect(payloads).toEqual([{ fileId: 12, isFolder: false, expiresInDays: 30, password: 'secret phrase', maxDownloads: 4 }])
    expect(screen.getByLabelText('Пароль (необязательно)')).toHaveValue('')
    expect(screen.queryByText('secret phrase')).not.toBeInTheDocument()
  })

  it('moves focus inside, traps it in both directions, closes with Escape, and restores the trigger', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, [])
    const user = userEvent.setup()
    render(<ShareHarness />)

    const trigger = screen.getByRole('button', { name: 'Open sharing' })
    await user.click(trigger)
    const close = screen.getByRole('button', { name: 'Закрыть общий доступ' })
    expect(close).toHaveFocus()

    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Создать ссылку' })).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes during loading and restores safely when the trigger disappears', async () => {
    apiClient.defaults.adapter = async () => await new Promise<AxiosResponse>(() => undefined)
    const user = userEvent.setup()
    render(<ShareHarness removeTriggerOnClose />)

    await user.click(screen.getByRole('button', { name: 'Open sharing' }))
    expect(screen.getByRole('button', { name: 'Закрыть общий доступ' })).toHaveFocus()
    expect(screen.getByText('Загружаем ссылки…')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open sharing' })).not.toBeInTheDocument()
  })

  it('keeps focus trapped and closes while a share mutation is pending', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get') return ok(config, [])
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      return await new Promise<AxiosResponse>(() => undefined)
    }
    const user = userEvent.setup()
    render(<ShareHarness />)

    const trigger = screen.getByRole('button', { name: 'Open sharing' })
    await user.click(trigger)
    await screen.findByText('Для этого объекта пока нет ссылок.')
    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }))

    const close = screen.getByRole('button', { name: 'Закрыть общий доступ' })
    await waitFor(() => expect(close).toHaveFocus())
    await user.tab({ shift: true })
    expect(screen.getByLabelText('Пароль (необязательно)')).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('creates a folder share with the mirror file id', async () => {
    let payload: unknown
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get') return ok(config, [])
      payload = JSON.parse(String(config.data))
      return ok(config, share(6, 'folder-token', 91, true))
    }
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 91, name: 'Docs', isFolder: true }} />)
    const user = userEvent.setup()
    await screen.findByText('Для этого объекта пока нет ссылок.')
    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }))
    await screen.findByText('Ссылка создана.')
    expect(payload).toEqual({ fileId: 91, isFolder: true, expiresInDays: 7 })
  })

  it('copies, opens, and revokes an existing share before refreshing', async () => {
    let shares = [share(7, 'copy-token', 12)]
    let deleteCalls = 0
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get') return ok(config, shares)
      if (config.method === 'delete' && config.url === '/sharing/7') {
        deleteCalls += 1
        shares = []
        return ok(config, { message: 'revoked' })
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`)
    }
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(await screen.findByRole('button', { name: 'Копировать ссылку' }))
    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/share/copy-token')
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(open).toHaveBeenCalledWith('http://localhost:3000/share/copy-token', '_blank', 'noopener,noreferrer')
    await user.click(screen.getByRole('button', { name: 'Закрыть доступ' }))
    await waitFor(() => expect(screen.getByText('Для этого объекта пока нет ссылок.')).toBeInTheDocument())
    expect(deleteCalls).toBe(1)
  })

  it('reports clipboard failure while leaving the URL visible', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, [share(9, 'still-visible', 12)])
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    await user.click(await screen.findByRole('button', { name: 'Копировать ссылку' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось скопировать ссылку')
    expect(screen.getByDisplayValue(/still-visible$/)).toBeInTheDocument()
  })

  it.each([
    [400, 'File exceeds maximum shareable size', 'Размер файла превышает лимит для общего доступа'],
    [400, 'File type not allowed for sharing', 'Для этого типа файлов общий доступ недоступен'],
    [403, 'private authorization details', 'У вас нет разрешения'],
    [404, 'Share link not found', 'больше недоступны'],
    [500, 'database /private/path failed', 'Не удалось обновить доступ'],
  ])('maps sharing HTTP %s errors without exposing backend details', async (status, backendMessage, expected) => {
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get') return ok(config, [])
      throw failure(config, status, backendMessage)
    }
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    const user = userEvent.setup()
    await screen.findByText('Для этого объекта пока нет ссылок.')
    await user.type(screen.getByLabelText('Пароль (необязательно)'), 'discard me')
    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(expected)
    expect(alert).not.toHaveTextContent(backendMessage)
    expect(screen.getByLabelText('Пароль (необязательно)')).toHaveValue('')
    expect(screen.queryByText('discard me')).not.toBeInTheDocument()
  })

  it('guards synchronous duplicate form submits before React renders the busy state', async () => {
    let posts = 0
    apiClient.defaults.adapter = async (config) => {
      if (config.method === 'get') return ok(config, [])
      posts += 1
      return await new Promise<AxiosResponse>(() => undefined)
    }
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    await screen.findByText('Для этого объекта пока нет ссылок.')
    const form = screen.getByRole('button', { name: 'Создать ссылку' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    await waitFor(() => expect(posts).toBe(1))
  })

  it('reports revoked shares and correctly disables repeated revocation', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, [{ ...share(1, 'revoked', 12), isActive: false }])
    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)
    expect(await screen.findByText('Доступ закрыт')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Закрыть доступ' })).toBeDisabled()
  })

  it('uses the existing session-expiry error model for owner share listing', async () => {
    apiClient.defaults.adapter = async (config) => { throw failure(config, 401, 'raw token failure') }

    render(<ShareDialog onClose={() => undefined} target={{ fileId: 12, name: 'photo.png', isFolder: false }} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Сеанс завершён')
    expect(alert).not.toHaveTextContent('raw token failure')
  })
})

function ShareHarness({ removeTriggerOnClose = false }: { removeTriggerOnClose?: boolean }) {
  const [open, setOpen] = useState(false)
  const [showTrigger, setShowTrigger] = useState(true)
  return <>{showTrigger ? <button onClick={() => setOpen(true)} type="button">Open sharing</button> : null}{open ? (
    <ShareDialog
      onClose={() => { if (removeTriggerOnClose) setShowTrigger(false); setOpen(false) }}
      target={{ fileId: 12, name: 'photo.png', isFolder: false }}
    />
  ) : null}</>
}

function share(id: number, token: string, fileId: number, isFolder = false) {
  return { id, token, fileId, isFolder, isActive: true, expiresAt: '2099-01-01T00:00:00.000Z', downloadCount: 0, maxDownloads: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

function ok<T>(config: InternalAxiosRequestConfig, data: T): AxiosResponse {
  return { data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config }
}

function failure(config: InternalAxiosRequestConfig, status: number, message: string) {
  return new AxiosError('failed', undefined, config, undefined, {
    config, status, statusText: 'Error', headers: new AxiosHeaders(), data: { statusCode: status, message },
  })
}
