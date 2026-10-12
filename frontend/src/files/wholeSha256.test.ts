// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeSha256BitLength, hashFileSha256, SHA256_READ_BYTES } from './wholeSha256'

// Keep Node's reference implementation confined to this test. The application
// intentionally has no Node dependencies or whole-file WebCrypto digest.
const nodeCryptoModule = 'node:crypto'
const { createHash } = await import(nodeCryptoModule) as {
  createHash: (algorithm: string) => {
    update: (bytes: Uint8Array) => { digest: (format: 'hex') => string }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('incremental whole-file SHA-256', () => {
  // RFC 6234 section 8.5 publishes the abc, 56-byte and million-a vectors:
  // https://www.rfc-editor.org/rfc/rfc6234#section-8.5
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])('matches published SHA-256 vector %#', async (input, expected) => {
    const bytes = new TextEncoder().encode(input)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected)
    expect(await hashFileSha256(new Blob([bytes]))).toBe(expected)
  })

  it.each([1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129,
    SHA256_READ_BYTES - 1, SHA256_READ_BYTES, SHA256_READ_BYTES + 1,
    SHA256_READ_BYTES * 2 + 123])('matches Node crypto across %i-byte padding and read boundaries', async (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 131 + (index >>> 8)) & 255)
    const expected = createHash('sha256').update(bytes).digest('hex')
    const progress: number[] = []
    const digest = await hashFileSha256(new Blob([bytes]), { onProgress: (value) => progress.push(value) })
    expect(digest).toBe(expected)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBe(size)
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1])).toBe(true)
  })

  it('reads only bounded, sequential slices and yields to another task', async () => {
    const size = SHA256_READ_BYTES * 3 + 7
    const reads: [number, number][] = []
    let activeReads = 0
    let maxActiveReads = 0
    let timerRan = false
    const file = {
      size,
      arrayBuffer: vi.fn(() => { throw new Error('Whole-file reads are forbidden') }),
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => {
          reads.push([start, end])
          activeReads += 1
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          await Promise.resolve()
          activeReads -= 1
          return new Uint8Array(end - start).buffer
        },
      }),
    } as unknown as Blob
    setTimeout(() => { timerRan = true }, 0)
    const digest = await hashFileSha256(file)
    expect(digest).toBe(createHash('sha256').update(new Uint8Array(size)).digest('hex'))
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(reads).toEqual([
      [0, SHA256_READ_BYTES], [SHA256_READ_BYTES, SHA256_READ_BYTES * 2],
      [SHA256_READ_BYTES * 2, SHA256_READ_BYTES * 3], [SHA256_READ_BYTES * 3, size],
    ])
    expect(reads.every(([start, end]) => end - start <= SHA256_READ_BYTES)).toBe(true)
    expect(maxActiveReads).toBe(1)
    expect(timerRan).toBe(true)
  })

  it('does not read a file when already cancelled', async () => {
    const file = new Blob(['abc'])
    const slice = vi.spyOn(file, 'slice')
    const controller = new AbortController()
    controller.abort()
    await expect(hashFileSha256(file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(slice).not.toHaveBeenCalled()
  })

  it('cancels between work batches without scheduling another file slice', async () => {
    const file = new Blob([new Uint8Array(SHA256_READ_BYTES * 2)])
    const slice = vi.spyOn(file, 'slice')
    const controller = new AbortController()
    const progress: number[] = []
    await expect(hashFileSha256(file, {
      signal: controller.signal,
      onProgress: (value) => {
        progress.push(value)
        if (value > 0) controller.abort()
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(slice).toHaveBeenCalledTimes(1)
    expect(progress[progress.length - 1]).toBeLessThan(SHA256_READ_BYTES)
  })

  it('rejects promptly on cancellation while a bounded read is pending', async () => {
    const controller = new AbortController()
    let release: (value: ArrayBuffer) => void = () => {}
    const read = new Promise<ArrayBuffer>((resolve) => { release = resolve })
    const slice = vi.fn(() => ({ arrayBuffer: () => read }))
    const file = { size: SHA256_READ_BYTES * 2, slice } as unknown as Blob
    const pending = hashFileSha256(file, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release(new ArrayBuffer(SHA256_READ_BYTES))
    await Promise.resolve()
    expect(slice).toHaveBeenCalledTimes(1)
  })

  it('delivers cancellation from another UI task during computation', async () => {
    const file = new Blob([new Uint8Array(SHA256_READ_BYTES * 3)])
    const slice = vi.spyOn(file, 'slice')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 0)
    await expect(hashFileSha256(file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(slice).toHaveBeenCalledTimes(1)
  })

  it('propagates file read failures and rejects incomplete reads', async () => {
    const failed = { size: 4, slice: () => ({ arrayBuffer: async () => { throw new Error('Read failed') } }) } as unknown as Blob
    await expect(hashFileSha256(failed)).rejects.toThrow('Read failed')
    const truncated = { size: 4, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(3) }) } as unknown as Blob
    await expect(hashFileSha256(truncated)).rejects.toThrow('Incomplete file read')
  })
})

describe('SHA-256 64-bit length encoding (synthetic lengths; no large-file qualification)', () => {
  it.each([
    [0, '0000000000000000'],
    [3, '0000000000000018'],
    [2 ** 29 - 1, '00000000fffffff8'],
    [2 ** 29, '0000000100000000'],
    [2 ** 32, '0000000800000000'],
    [50 * 1024 ** 3, '0000006400000000'],
    [50 * 1024 ** 3 + 1, '0000006400000008'],
    [Number.MAX_SAFE_INTEGER, '00fffffffffffff8'],
  ])('encodes %i bytes without truncating high bits', (size, expected) => {
    expect(Array.from(encodeSha256BitLength(size), (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(expected)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects an invalid length %s', (size) => {
    expect(() => encodeSha256BitLength(size)).toThrow(RangeError)
  })
})
