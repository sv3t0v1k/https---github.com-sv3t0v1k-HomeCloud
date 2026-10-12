import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FinalizationOperation,
  FinalizationStore,
} from "./ssd-finalization-contract";
import { ArtifactIdentity } from "./ssd-recovery-contract";
export const FINALIZER_BUFFER_BYTES = 64 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const sync = (fd: number) =>
  new Promise<void>((resolve, reject) =>
    fs.fsync(fd, (error) => (error ? reject(error) : resolve())),
  );
const read = (fd: number, buffer: Buffer) =>
  new Promise<number>((resolve, reject) =>
    fs.read(fd, buffer, 0, buffer.length, null, (error, size) =>
      error ? reject(error) : resolve(size),
    ),
  );
async function writeAll(fd: number, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const size = await new Promise<number>((resolve, reject) =>
      fs.write(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
        (error, count) => (error ? reject(error) : resolve(count)),
      ),
    );
    if (size <= 0) throw new Error("Finalization write made no progress");
    offset += size;
  }
}
const close = (fd: number) =>
  new Promise<void>((resolve, reject) =>
    fs.close(fd, (error) => (error ? reject(error) : resolve())),
  );

let running = false;
export function acquireFinalizationSlot(): () => void {
  if (running) throw new Error("Isolated finalizer is busy");
  running = true;
  return () => {
    running = false;
  };
}
export function identity(fd: number): ArtifactIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}
export function sameIdentity(
  left: ArtifactIdentity,
  right: ArtifactIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}
export function validateLayout(operation: FinalizationOperation): void {
  if (
    !Number.isSafeInteger(operation.totalSize) ||
    operation.totalSize <= 0 ||
    !Number.isSafeInteger(operation.chunkSize) ||
    operation.chunkSize <= 0 ||
    !Number.isSafeInteger(operation.totalChunks) ||
    operation.totalChunks <= 0 ||
    operation.totalChunks !==
      Math.ceil(operation.totalSize / operation.chunkSize) ||
    !sha256.test(operation.expectedSha256)
  )
    throw new Error("Invalid finalization layout");
}
export async function assemble(
  operation: FinalizationOperation,
  store: FinalizationStore,
  filesystem: {
    assertBinding(binding: FinalizationOperation["binding"]): void;
    openChunk(binding: FinalizationOperation["binding"], index: number): number;
  },
  targetFd: number,
): Promise<void> {
  let pendingWrite: Promise<void> | undefined;
  try {
    // Keep the same exclusively-created descriptor through size check and fsync.
    const writer = new Writable({
      highWaterMark: FINALIZER_BUFFER_BYTES,
      write(buffer: Buffer, _encoding, callback) {
        pendingWrite = writeAll(targetFd, buffer);
        void pendingWrite.then(() => callback(), callback);
      },
    });
    const wholeHash = createHash("sha256");
    let bytes = 0;
    const binding = operation.binding,
      id = operation.id;
    async function* sequence() {
      let index = 0;
      for await (const part of store.chunks(id)) {
        const expectedSize =
          index === operation.totalChunks - 1
            ? operation.totalSize - index * operation.chunkSize
            : operation.chunkSize;
        if (
          index >= operation.totalChunks ||
          part.chunkIndex !== index ||
          part.byteSize !== expectedSize ||
          !sha256.test(part.sha256)
        )
          throw new Error("Invalid finalization manifest");
        filesystem.assertBinding(binding);
        const chunkFd = filesystem.openChunk(binding, index);
        try {
          const before = fs.fstatSync(chunkFd);
          if (
            !before.isFile() ||
            before.size !== expectedSize ||
            before.nlink !== 1
          )
            throw new Error("Chunk size or type mismatch");
          const partHash = createHash("sha256");
          let partBytes = 0;
          while (partBytes < expectedSize) {
            // A fresh bounded block remains owned by the pipeline until its
            // write callback finishes; never reuse a buffer still in flight.
            const block = Buffer.allocUnsafe(
              Math.min(FINALIZER_BUFFER_BYTES, expectedSize - partBytes),
            );
            const count = await read(chunkFd, block);
            if (count === 0) throw new Error("Truncated finalization chunk");
            const buffer = block.subarray(0, count);
            partBytes += count;
            bytes += count;
            if (partBytes > expectedSize || bytes > operation.totalSize)
              throw new Error("Finalization size exceeded");
            partHash.update(buffer);
            wholeHash.update(buffer);
            yield buffer;
          }
          const after = fs.fstatSync(chunkFd);
          if (
            partBytes !== expectedSize ||
            after.size !== expectedSize ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            partHash.digest("hex") !== part.sha256
          )
            throw new Error("Chunk integrity mismatch");
        } finally {
          await close(chunkFd);
        }
        index++;
      }
      if (index !== operation.totalChunks)
        throw new Error("Incomplete finalization manifest");
    }
    await pipeline(sequence(), writer);
    if (
      bytes !== operation.totalSize ||
      fs.fstatSync(targetFd).size !== operation.totalSize ||
      wholeHash.digest("hex") !== operation.expectedSha256
    )
      throw new Error("Whole-file integrity mismatch");
    await sync(targetFd);
  } finally {
    await pendingWrite?.catch(() => undefined);
  }
}
/** Streaming verification holds one block and detects size/identity changes. */
export async function verify(
  fd: number,
  size: number,
  expectedHash: string,
): Promise<ArtifactIdentity> {
  const before = fs.fstatSync(fd, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size !== BigInt(size) ||
    before.uid !== BigInt(process.geteuid!()) ||
    (before.mode & 0o077n) !== 0n
  )
    throw new Error("Untrusted recovery artifact");
  const expectedIdentity = identity(fd),
    hash = createHash("sha256");
  let bytes = 0;
  while (bytes < size) {
    const block = Buffer.allocUnsafe(
      Math.min(FINALIZER_BUFFER_BYTES, size - bytes),
    );
    const count = await read(fd, block);
    if (!count) throw new Error("Truncated recovery artifact");
    hash.update(block.subarray(0, count));
    bytes += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  if (
    after.size !== before.size ||
    !sameIdentity(expectedIdentity, identity(fd)) ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    hash.digest("hex") !== expectedHash
  )
    throw new Error("Recovery artifact integrity mismatch");
  return expectedIdentity;
}
export { close };
