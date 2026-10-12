import * as fs from "node:fs";
import { FileEntity } from "../entities/file.entity";
import { FinalizationChunk } from "./ssd-finalization-contract";
import {
  ArtifactIdentity,
  RecoveryFilesystem,
  RecoveryOperation,
  RecoveryStore,
} from "./ssd-recovery-contract";
import {
  acquireFinalizationSlot,
  assemble,
  close,
  identity,
  sameIdentity,
  validateLayout,
  verify,
} from "./ssd-finalization-stream";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Explicit restart entry point, unwired from API/bootstrap/schedulers.
 * Each invocation makes one bounded replay attempt. Journal truth is always
 * fetched from the primary DB; errors never compensate or delete target bytes.
 */
export class SsdFinalizationRecovery {
  constructor(
    private readonly store: RecoveryStore,
    private readonly filesystem: RecoveryFilesystem,
  ) {}

  async recover(operationId: string): Promise<FileEntity | null> {
    if (!uuid.test(operationId))
      throw new Error("Invalid recovery operation identity");
    const release = acquireFinalizationSlot();
    try {
      let outcome = await this.store.lookup(operationId);
      let operation = outcome.operation;
      validateLayout(operation);
      if (operation.cleanupState === "cleaned") return outcome.file;
      // Kernel lock cannot be stolen from a paused/live worker, including one
      // that lost its DB connection. A real process exit releases it.
      this.filesystem.reopen(operation);
      const current = await this.store.lookup(operationId);
      if (JSON.stringify(current.operation) !== JSON.stringify(operation))
        throw new Error("Recovery journal changed during acquisition");
      if (operation.state === "assembling") {
        const final = this.filesystem.inspectTarget(operation.binding, true);
        if (final) {
          await close(final.fd);
          throw new Error("Unexpected assembled final artifact");
        }
        const temporary = this.filesystem.inspectTarget(
          operation.binding,
          false,
        );
        let complete = false;
        if (temporary) {
          try {
            this.requireIdentity(operation, temporary.identity);
            const size = fs.fstatSync(temporary.fd).size;
            if (size > operation.totalSize)
              throw new Error("Oversized recovery temporary");
            if (size === operation.totalSize) {
              await verify(
                temporary.fd,
                operation.totalSize,
                operation.expectedSha256,
              );
              complete = true;
            }
          } finally {
            await close(temporary.fd);
          }
        } else if (operation.targetIdentity) {
          throw new Error("Recorded target artifact is missing");
        }
        if (!complete) {
          // Never destroy a potentially useful partial copy until every source
          // chunk has independently passed bounded verification.
          for await (const part of this.manifest(operation)) {
            if (!(await this.verifyChunk(operation, part)))
              throw new Error("Missing recovery source chunk");
          }
          const writer = temporary
            ? this.filesystem.resetTemporary(
                operation.binding,
                temporary.identity,
              )
            : this.filesystem.createTemporary(operation.binding);
          try {
            await this.store.recordTarget(operation.id, identity(writer));
            await assemble(operation, this.store, this.filesystem, writer);
          } finally {
            await close(writer);
          }
        }
        this.filesystem.syncTarget(operation.binding, false);
        await this.store.transition(operation.id, "assembling", "verified");
        operation = (await this.store.lookup(operation.id)).operation;
      }
      if (operation.state === "verified" || operation.state === "publishing") {
        const temporary = this.filesystem.inspectTarget(
          operation.binding,
          false,
        );
        let final: ReturnType<RecoveryFilesystem["inspectTarget"]> = null;
        try {
          final = this.filesystem.inspectTarget(operation.binding, true);
          if ((!temporary && !final) || (temporary && final))
            throw new Error("Ambiguous publication artifacts");
          if (operation.state === "verified" && final)
            throw new Error("Final artifact without publication intent");
          const artifact = temporary ?? final!;
          this.requireIdentity(operation, artifact.identity);
          await verify(
            artifact.fd,
            operation.totalSize,
            operation.expectedSha256,
          );
          this.filesystem.syncTarget(operation.binding, !!final);
        } finally {
          if (temporary) await close(temporary.fd);
          if (final) await close(final.fd);
        }
        if (operation.state === "verified") {
          await this.store.transition(operation.id, "verified", "publishing");
        }
        if (temporary) this.filesystem.publish(operation.binding);
        // A rename may have succeeded before throwing, or before parent fsync.
        // Next invocation discovers the same inode at the final name and syncs it.
        this.filesystem.syncTarget(operation.binding, true);
        await this.store.transition(operation.id, "publishing", "published");
        operation = (await this.store.lookup(operation.id)).operation;
      }
      if (operation.state !== "published" && operation.state !== "committed")
        throw new Error("Unsupported recovery outcome");
      await this.verifyFinal(operation);
      if (operation.state === "published") {
        // Response loss is handled by authoritative lookup on a later invocation,
        // never an eager retry or a compensating quota update.
        await this.store.commit(operation.id);
      }
      outcome = await this.store.lookup(operation.id);
      if (outcome.operation.state !== "committed" || !outcome.file)
        throw new Error("Authoritative committed outcome required for cleanup");
      operation = outcome.operation;
      await this.verifyFinal(operation);
      // Preflight every known chunk before any deletion. Unknown names are never
      // enumerated; missing known chunks are valid after an interrupted cleanup.
      for await (const part of this.manifest(operation)) {
        await this.verifyChunk(operation, part);
      }
      for await (const part of this.manifest(operation)) {
        const observed = await this.verifyChunk(operation, part);
        if (observed)
          this.filesystem.removeChunk(operation.binding, part, observed);
      }
      this.filesystem.syncSource(operation.binding);
      this.filesystem.assertBinding(operation.binding);
      await this.store.finishCleanup(operation.id);
      return outcome.file;
    } finally {
      try {
        this.filesystem.close();
      } finally {
        release();
      }
    }
  }

  private requireIdentity(
    operation: RecoveryOperation,
    observed: ArtifactIdentity,
  ): void {
    if (
      !operation.targetIdentity ||
      !sameIdentity(operation.targetIdentity, observed)
    )
      throw new Error("Recovery target identity is not journal-owned");
  }

  private async verifyFinal(operation: RecoveryOperation): Promise<void> {
    this.filesystem.assertBinding(operation.binding);
    const temporary = this.filesystem.inspectTarget(operation.binding, false);
    if (temporary) {
      await close(temporary.fd);
      throw new Error("Unexpected temporary after publication");
    }
    const final = this.filesystem.inspectTarget(operation.binding, true);
    if (!final) throw new Error("Published target is missing");
    try {
      this.requireIdentity(operation, final.identity);
      await verify(final.fd, operation.totalSize, operation.expectedSha256);
      this.filesystem.syncTarget(operation.binding, true);
      this.filesystem.assertBinding(operation.binding);
    } finally {
      await close(final.fd);
    }
  }

  private async *manifest(
    operation: RecoveryOperation,
  ): AsyncIterable<FinalizationChunk> {
    let index = 0;
    for await (const part of this.store.chunks(operation.id)) {
      const size =
        index === operation.totalChunks - 1
          ? operation.totalSize - index * operation.chunkSize
          : operation.chunkSize;
      if (
        part.chunkIndex !== index ||
        index >= operation.totalChunks ||
        part.byteSize !== size ||
        !/^[0-9a-f]{64}$/.test(part.sha256)
      )
        throw new Error("Invalid recovery manifest");
      yield part;
      index++;
    }
    if (index !== operation.totalChunks)
      throw new Error("Incomplete recovery manifest");
  }

  private async verifyChunk(
    operation: RecoveryOperation,
    part: FinalizationChunk,
  ): Promise<ArtifactIdentity | null> {
    this.filesystem.assertBinding(operation.binding);
    let fd: number;
    try {
      fd = this.filesystem.openChunk(operation.binding, part.chunkIndex);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    try {
      return await verify(fd, part.byteSize, part.sha256);
    } finally {
      await close(fd);
    }
  }
}

/** Explicit bounded restart sweep. No automatic loops or unbounded Promise.all. */
export async function* recoverPendingSsdFinalizations(
  store: RecoveryStore,
  factory: () => RecoveryFilesystem,
): AsyncIterable<{ id: string; recovered: boolean }> {
  for await (const id of store.pending()) {
    try {
      await new SsdFinalizationRecovery(store, factory()).recover(id);
      yield { id, recovered: true };
    } catch {
      yield { id, recovered: false };
    }
  }
}
