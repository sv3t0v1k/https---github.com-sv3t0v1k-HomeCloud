export interface LoginDto {
  email: string
  password: string
}

export interface RegisterDto {
  email: string
  password: string
  name?: string
}

export interface Tokens {
  accessToken: string
  refreshToken: string
}

export interface User {
  id: number
  email: string
  name: string
  isActive: boolean
  isEmailVerified: boolean
  avatar: string | null
  storageQuota: string | number
  storageUsed: string | number
  createdAt: string
  updatedAt: string
}
