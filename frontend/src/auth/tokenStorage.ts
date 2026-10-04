import type { Tokens } from '../types/auth'

const REFRESH_TOKEN_KEY = 'homecloud.refreshToken'
let accessToken: string | null = null
let sessionEpoch = 0
let ownerGeneration = 0

// The backend does not offer httpOnly refresh cookies. sessionStorage is the
// narrowest reload-persistent option, but remains readable by injected scripts.
// This foundation deliberately does not promise XSS-safe or multi-tab sessions.
export const tokenStorage = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => sessionStorage.getItem(REFRESH_TOKEN_KEY),
  getEpoch: () => sessionEpoch,
  getOwnerGeneration: () => ownerGeneration,
  set(tokens: Tokens) {
    ownerGeneration += 1
    sessionEpoch += 1
    accessToken = tokens.accessToken
    sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
  },
  setIfCurrent(tokens: Tokens, expectedEpoch: number) {
    if (sessionEpoch !== expectedEpoch) return false
    // A token rotation stays within the same authenticated owner boundary.
    sessionEpoch += 1
    accessToken = tokens.accessToken
    sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
    return true
  },
  clear() {
    ownerGeneration += 1
    sessionEpoch += 1
    accessToken = null
    sessionStorage.removeItem(REFRESH_TOKEN_KEY)
  },
}
