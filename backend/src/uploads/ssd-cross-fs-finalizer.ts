import { randomUUID } from "node:crypto";
import { FileEntity } from "../entities/file.entity";
import {
  FinalizationFilesystem,
  FinalizationStore,
} from "./ssd-finalization-contract";

import {
  acquireFinalizationSlot,
  assemble,
  close,
  identity,
  validateLayout,
} from "./ssd-finalization-stream";
export { FINALIZER_BUFFER_BYTES } from "./ssd-finalization-stream";
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Isolated, explicitly invoked component: deliberately absent from Nest providers,
 * controllers, startup recovery and schedulers. No retries or destructive compensation.
 * A durable global journal reservation additionally fences other processes/restarts.
 */
export class SsdCrossFsFinalizer {
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
    const release = acquireFinalizationSlot();
    let fd: number | undefined;
    try {
      const id = randomUUID();
      const binding = this.filesystem.prepare(input.userId, input.uploadId, id);
      const operation = await this.store.begin({ ...input, id, binding });
      validateLayout(operation);
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
      await this.store.recordTarget(id, identity(fd));
      await assemble(operation, this.store, this.filesystem, fd);
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
        // assemble drains any pending write before returning or throwing.
        if (fd !== undefined) await close(fd);
      } finally {
        try {
          this.filesystem.close();
        } finally {
          release();
        }
      }
    }
  }
}
