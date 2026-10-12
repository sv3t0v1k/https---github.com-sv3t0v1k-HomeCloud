// SHA-256 per NIST FIPS 180-4, sections 4.1.2, 4.2.2, 5.1.1 and 6.2.2:
// https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
// Keep only one bounded file slice, the partial 64-byte block and hash state.
export const SHA256_READ_BYTES = 2 * 1024 * 1024
const WORK_BYTES = 256 * 1024

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** Big-endian 64-bit bit length; never truncate the byte counter to 32 bits. */
export function encodeSha256BitLength(byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('Invalid SHA-256 byte length')
  }
  let bits = BigInt(byteLength) * 8n
  const result = new Uint8Array(8)
  for (let index = 7; index >= 0; index -= 1) {
    result[index] = Number(bits & 255n)
    bits >>= 8n
  }
  return result
}

class IncrementalSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private schedule = new Uint32Array(64)
  private tail = new Uint8Array(64)
  private tailBytes = 0
  private byteLength = 0

  update(bytes: Uint8Array): void {
    this.byteLength += bytes.length
    let offset = 0
    if (this.tailBytes > 0) {
      const take = Math.min(64 - this.tailBytes, bytes.length)
      this.tail.set(bytes.subarray(0, take), this.tailBytes)
      this.tailBytes += take
      offset = take
      if (this.tailBytes === 64) {
        this.compress(this.tail, 0)
        this.tailBytes = 0
      }
    }
    while (offset + 64 <= bytes.length) {
      this.compress(bytes, offset)
      offset += 64
    }
    if (offset < bytes.length) {
      this.tail.set(bytes.subarray(offset), 0)
      this.tailBytes = bytes.length - offset
    }
  }

  digest(): string {
    const padded = new Uint8Array(this.tailBytes < 56 ? 64 : 128)
    padded.set(this.tail.subarray(0, this.tailBytes))
    padded[this.tailBytes] = 0x80
    padded.set(encodeSha256BitLength(this.byteLength), padded.length - 8)
    for (let offset = 0; offset < padded.length; offset += 64) this.compress(padded, offset)
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('')
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const words = this.schedule
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] = (bytes[start] << 24) | (bytes[start + 1] << 16)
        | (bytes[start + 2] << 8) | bytes[start + 3]
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]
      const y = words[index - 2]
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      words[index] = (sigma1 + words[index - 7] + sigma0 + words[index - 16]) >>> 0
    }
    let a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3]
    let e = this.state[4], f = this.state[5], g = this.state[6], h = this.state[7]
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    this.state[0] = (this.state[0] + a) >>> 0
    this.state[1] = (this.state[1] + b) >>> 0
    this.state[2] = (this.state[2] + c) >>> 0
    this.state[3] = (this.state[3] + d) >>> 0
    this.state[4] = (this.state[4] + e) >>> 0
    this.state[5] = (this.state[5] + f) >>> 0
    this.state[6] = (this.state[6] + g) >>> 0
    this.state[7] = (this.state[7] + h) >>> 0
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Hashing cancelled', 'AbortError')
}

async function readSlice(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  checkAbort(signal)
  if (!signal) return blob.arrayBuffer()
  // Blob.arrayBuffer has no abort API. Reject promptly while the single bounded
  // read settles in the background; never start another read after cancellation.
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Hashing cancelled', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([blob.arrayBuffer(), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export interface HashFileOptions {
  signal?: AbortSignal
  onProgress?: (bytesHashed: number) => void
}

/** Incremental whole-file digest. Progress counts hashed file bytes, without padding. */
export async function hashFileSha256(file: Blob, { signal, onProgress }: HashFileOptions = {}): Promise<string> {
  checkAbort(signal)
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new RangeError('Invalid file size')
  const hash = new IncrementalSha256()
  onProgress?.(0)
  let lastYield = performance.now()
  for (let start = 0; start < file.size; start += SHA256_READ_BYTES) {
    checkAbort(signal)
    const end = Math.min(file.size, start + SHA256_READ_BYTES)
    const bytes = new Uint8Array(await readSlice(file.slice(start, end), signal))
    checkAbort(signal)
    if (bytes.length !== end - start) throw new Error('Incomplete file read during SHA-256')
    for (let offset = 0; offset < bytes.length; offset += WORK_BYTES) {
      checkAbort(signal)
      const workEnd = Math.min(bytes.length, offset + WORK_BYTES)
      hash.update(bytes.subarray(offset, workEnd))
      onProgress?.(start + workEnd)
      // A task boundary lets paint, input and AbortSignal delivery run; a resolved
      // Promise alone would keep this work in the microtask queue.
      if (performance.now() - lastYield >= 8 || workEnd === bytes.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        checkAbort(signal)
        lastYield = performance.now()
      }
    }
  }
  checkAbort(signal)
  return hash.digest()
}
