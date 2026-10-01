import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import { LoginPage } from '../auth/LoginPage'

vi.mock('../auth/SessionContext', () => ({
  useSession: () => ({ status: 'anonymous', notice: null, login: async () => undefined }),
}))

// Package-level regression: these targets are not exposed as public HomeCloud input.
function NavigationProbe({ target }: { target: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(target)}>Navigate</button>
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('GHSA-wrjc-x8rr-h8h6 package navigation', () => {
  it.each(['/files', '/files/folders/7', '/files/trash'])('preserves internal target %s', (target) => {
    render(<BrowserRouter><NavigationProbe target={target} /></BrowserRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(window.location.pathname).toBe(target)
  })

  it.each(['//attacker.example', '/\\attacker.example', '\\/attacker.example', '\\\\attacker.example'])('keeps mixed-separator target %s on the current origin', (target) => {
    const origin = window.location.origin
    render(<BrowserRouter><NavigationProbe target={target} /></BrowserRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(window.location.origin).toBe(origin)
    expect(window.location.pathname).toBe('/attacker.example')
  })
})

// Locally injected history state exercises the existing login surface; it is not
// evidence that a remote attacker can supply state.from in HomeCloud.
describe('HomeCloud login return navigation', () => {
  it.each([
    ['/files/folders/7', '/files/folders/7'],
    ['/files/trash', '/files/trash'],
    ['//attacker.example', '/files'],
    ['https://attacker.example', '/files'],
    ['/\\attacker.example', '/attacker.example'],
  ])('handles local return state %s without leaving the origin', async (from, expected) => {
    const origin = window.location.origin
    window.history.replaceState({ usr: { from } }, '', '/login')
    render(<BrowserRouter><LoginPage /></BrowserRouter>)
    fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(window.location.pathname).toBe(expected))
    expect(window.location.origin).toBe(origin)
  })
})
