import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider, useSession } from './SessionContext'
import { tokenStorage } from './tokenStorage'
import { apiRequest, refreshSession } from '../api/client'
import type { User } from '../types/auth'
vi.mock('../api/client', () => ({ apiRequest: vi.fn(), refreshSession: vi.fn(), clearSession: () => tokenStorage.clear() }))
const user = { id: 1, name: 'Old', email: 'owner@example.test' } as User
function Probe() {
  const session = useSession()
  return <><p>{session.status}:{session.user?.name}</p><button onClick={() => session.updateUser({ ...user, name: 'New' })}>Update</button><button onClick={() => session.endSession()}>End</button></>
}
afterEach(() => { cleanup(); tokenStorage.clear(); vi.clearAllMocks() })
describe('Session profile updates', () => {
  it('updates authenticated user without refresh and cannot resurrect an ended session', async () => {
    tokenStorage.set({ accessToken: 'access', refreshToken: 'refresh' })
    vi.mocked(refreshSession).mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' })
    vi.mocked(apiRequest).mockResolvedValue(user)
    render(<SessionProvider><Probe /></SessionProvider>)
    await screen.findByText('authenticated:Old')
    const events = userEvent.setup()
    await events.click(screen.getByText('Update'))
    expect(screen.getByText('authenticated:New')).toBeInTheDocument()
    expect(refreshSession).toHaveBeenCalledTimes(1)
    await events.click(screen.getByText('End'))
    await events.click(screen.getByText('Update'))
    await waitFor(() => expect(screen.getByText('anonymous:')).toBeInTheDocument())
  })
})
