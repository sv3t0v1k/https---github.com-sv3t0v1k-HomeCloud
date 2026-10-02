import { apiRequest, refreshSession } from '../api/client'
import type { User } from '../types/auth'
export interface StorageInfo { storageQuota: string | number; storageUsed: string | number; fileCount: number; folderCount: number }
export function getStorageInfo(signal?: AbortSignal) { return apiRequest<StorageInfo>({ method: 'GET', url: '/files/storage-info', signal }) }
export function updateProfile(name: string, avatar: string) { return apiRequest<User>({ method: 'PATCH', url: '/users/me', data: { name, avatar } }) }
export async function changePassword(oldPassword: string, newPassword: string) { await refreshSession(); return apiRequest<{ message: string }>({ method: 'POST', url: '/auth/change-password', data: { oldPassword, newPassword }, skipRefresh: true }) }
