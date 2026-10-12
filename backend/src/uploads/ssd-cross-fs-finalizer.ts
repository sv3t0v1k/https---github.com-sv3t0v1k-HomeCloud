import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileEntity } from "../entities/file.entity";
import {
  FinalizationFilesystem,
  FinalizationOperation,
  FinalizationStore,
} from "./ssd-finalization-contract";

export const FINALIZER_BUFFER_BYTES = 64 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** Isolated, explicitly invoked component: deliberately absent from Nest providers,
 * controllers, startup recovery and schedulers. No retries or destructive compensation.
 * A durable global journal reservation additionally fences other processes/restarts.
 */
export class SsdCrossFsFinalizer {
  private static running = false;
  constructor(
    private readonly store: FinalizationStore,
    private readonly filesystem: FinalizationFilesystem,
  ) {}

  async finalize(input: {
    userId: number;
    uploadId: string;
    expectedSha256: string;
  }): Promise<FileEntity> {
    if (
      !Number.isSafeInteger(input.userId) ||
      input.userId <= 0 ||
      !uuid.test(input.uploadId) ||
      !sha256.test(input.expectedSha256)
    )
      throw new Error("Invalid isolated finalization request");
    if (SsdCrossFsFinalizer.running)
      throw new Error("Isolated finalizer is busy");
    SsdCrossFsFinalizer.running = true;
    let fd: number | undefined;
    let pendingWrite: Promise<void> | undefined;
    try {
      const id = randomUUID();
      const binding = this.filesystem.prepare(input.userId, input.uploadId, id);
      const operation = await this.store.begin({ ...input, id, binding });
      this.validate(operation);
      if (
        operation.id !== id ||
        operation.userId !== input.userId ||
        operation.uploadId !== input.uploadId ||
        operation.expectedSha256 !== input.expectedSha256 ||
        Object.keys(operation.binding).length !== Object.keys(binding).length ||
        Object.entries(binding).some(
          ([key, value]) =>
            operation.binding[key as keyof typeof binding] !== value,
        )
      )
        throw new Error("Journal reservation mismatch");
      this.filesystem.assertBinding(binding);
      fd = this.filesystem.createTemporary(binding);
      // Keep the same exclusively-created descriptor through size check and fsync.
      const targetFd = fd;
      const writer = new Writable({
        highWaterMark: FINALIZER_BUFFER_BYTES,
        write(buffer: Buffer, _encoding, callback) {
          pendingWrite = writeAll(targetFd, buffer);
          void pendingWrite.then(() => callback(), callback);
        },
      });
      const wholeHash = createHash("sha256");
      let bytes = 0;
      const store = this.store,
        filesystem = this.filesystem;
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
        fs.fstatSync(fd).size !== operation.totalSize ||
        wholeHash.digest("hex") !== operation.expectedSha256
      )
        throw new Error("Whole-file integrity mismatch");
      await sync(fd);
      const completedFd = fd;
      fd = undefined;
      await close(completedFd);
      await this.store.transition(id, "assembling", "verified");
      this.filesystem.assertBinding(binding);
      // Intent precedes rename: a crash/error can leave either name. Recovery
      // must inspect identity+bytes; never infer absence from the journal alone.
      await this.store.transition(id, "verified", "publishing");
      this.filesystem.publish(binding);
      await this.store.transition(id, "publishing", "published");
      this.filesystem.assertBinding(binding);
      return await this.store.commit(id);
    } finally {
      try {
        // pipeline destruction may precede an outstanding OS write callback.
        // Drain that single bounded write before releasing its descriptor.
        await pendingWrite?.catch(() => undefined);
        if (fd !== undefined) await close(fd);
      } finally {
        try {
          this.filesystem.close();
        } finally {
          SsdCrossFsFinalizer.running = false;
        }
      }
    }
  }

  private validate(operation: FinalizationOperation): void {
    if (
      !Number.isSafeInteger(operation.totalSize) ||
      operation.totalSize <= 0 ||
      !Number.isSafeInteger(operation.chunkSize) ||
      operation.chunkSize <= 0 ||
      !Number.isSafeInteger(operation.totalChunks) ||
      operation.totalChunks <= 0 ||
      operation.totalChunks !==
        Math.ceil(operation.totalSize / operation.chunkSize)
    )
      throw new Error("Invalid finalization layout");
  }
}
