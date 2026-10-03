import { describe, expect, it } from 'vitest'
import { formatBytes, storagePercent } from './formatBytes'

describe('Russian byte display', () => {
  it.each([[0, '0 Б'], [842, '842 Б'], [1023, '1 023 Б'], [1024, '1 КБ'], [12698, '12,4 КБ'], [7130317, '6,8 МБ'], [1825361101, '1,7 ГБ'], [2528876743885, '2,3 ТБ']])('formats %s', (value, expected) => {
    expect(formatBytes(value).replace(/\u00a0/g, ' ')).toBe(expected)
  })
  it.each([1, 2, 3, 4])('rounds near and exact unit %s boundaries consistently', (power) => {
    const boundary = 1024n ** BigInt(power)
    const label = ['КБ', 'МБ', 'ГБ', 'ТБ'][power - 1]
    expect(formatBytes(boundary)).toBe(`1 ${label}`)
    expect(formatBytes(boundary + 1n)).toBe(`1 ${label}`)
    expect(formatBytes(boundary - 1n)).toBe(power === 1 ? '1\u00a0023 Б' : `1 ${label}`)
    expect(formatBytes(boundary * 9n / 10n)).toContain(power === 1 ? ' Б' : ['КБ', 'МБ', 'ГБ'][power - 2])
  })
  it.each([null, undefined, '', 'unknown', '-1', '1.5', '1e3', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unknown or unsafe input %s', (value) => {
    expect(formatBytes(value)).toBe('Нет данных')
  })
  it('preserves string BIGINT and caps supported units at TB', () => {
    expect(formatBytes('9223372036854775807')).toBe('8\u00a0388\u00a0608 ТБ')
    expect(formatBytes('1024')).toBe(formatBytes(1024))
    expect(formatBytes('0')).toBe('0 Б')
  })
  it('derives only valid clamped usage without altering text', () => {
    expect(storagePercent('186', '1000')).toBe(18.6)
    expect(storagePercent('200', '100')).toBe(100)
    expect(storagePercent('0', '100')).toBe(0)
    expect(storagePercent('1', '0')).toBeNull()
    expect(storagePercent(null, '100')).toBeNull()
    expect(storagePercent('invalid', '100')).toBeNull()
    expect(storagePercent('9223372036854775806', '9223372036854775807')).toBe(99.99)
  })
})
