// API BIGINT values remain exact until rounding for display. Units follow the existing 1024 convention.
export type ByteValue = string | number | bigint | null | undefined

function byteInteger(value: ByteValue): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

export function formatBytes(value: ByteValue): string {
  const bytes = byteInteger(value)
  if (bytes === null) return 'Нет данных'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let unit = 0
  let divisor = 1n
  while (unit < units.length - 1 && bytes >= divisor * 1024n) { divisor *= 1024n; unit += 1 }
  if (unit === 0) return `${bytes.toLocaleString('ru-RU')} Б`
  let tenths = (bytes * 10n + divisor / 2n) / divisor
  // Avoid a rounded 1024 КБ immediately below the next boundary.
  if (tenths >= 10240n && unit < units.length - 1) {
    divisor *= 1024n; unit += 1
    tenths = (bytes * 10n + divisor / 2n) / divisor
  }
  return `${(tenths / 10n).toLocaleString('ru-RU')}${tenths % 10n ? `,${tenths % 10n}` : ''} ${units[unit]}`
}

export function storagePercent(used: ByteValue, quota: ByteValue): number | null {
  const usage = byteInteger(used)
  const limit = byteInteger(quota)
  if (usage === null || limit === null || limit === 0n) return null
  return Number(usage >= limit ? 10000n : usage * 10000n / limit) / 100
}
