import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { LoginPage } from './LoginPage'

vi.mock('./SessionContext', () => ({ useSession: () => ({ status: 'authenticated' }) }))
afterEach(cleanup)

function Destination() {
  const location = useLocation()
  return <output>{location.pathname}{location.search}</output>
}

describe('completed login rendering preserves the same return destination as submit', () => {
  it.each([
    ['/files/search?q=report&offset=20', '/files/search?q=report&offset=20'],
    ['/files/folders/7', '/files/folders/7'],
    ['https://outside.example', '/files'],
    ['//outside.example', '/files'],
  ])('keeps destination %s through an authenticated render', async (from, expected) => {
    render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { from } }]}><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Destination />} />
    </Routes></MemoryRouter>)
    expect(await screen.findByRole('status')).toHaveTextContent(expected)
  })
})
