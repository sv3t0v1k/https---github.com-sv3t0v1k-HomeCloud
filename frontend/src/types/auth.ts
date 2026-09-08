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
  access_token: string
  refresh_token: string
}

export interface User {
  id: string
  email: string
  name?: string
  created_at: string
  updated_at: string
}
