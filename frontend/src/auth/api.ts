import { apiRequest, refreshSession } from '../api/client'
import type { LoginDto, Tokens } from '../types/auth'

export function login(credentials: LoginDto) {
  return apiRequest<Tokens>({
    method: 'POST',
    url: '/auth/login',
    data: credentials,
    skipAuth: true,
  })
}

export async function logout() {
  // Rotate first so the logout request uses a matching, currently valid
  // access/refresh pair. Automatic 401 refresh is disabled for the final call
  // because replaying its old body after rotation would leave the new token live.
  const tokens = await refreshSession()
  await apiRequest<void>({
    method: 'POST',
    url: '/auth/logout',
    data: { refreshToken: tokens.refreshToken },
    skipRefresh: true,
  })
}
