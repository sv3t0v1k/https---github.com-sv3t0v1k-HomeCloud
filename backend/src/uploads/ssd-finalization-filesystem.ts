import * as fs from "node:fs";
import * as path from "node:path";
import { StorageService } from "../storage/storage.service";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";
import { UploadWorkspaceIdentity } from "./upload-workspace";
import { PreparedSsdWorkspace } from "./prepared-ssd-workspace";
import { SecureFilesystem } from "./secure-filesystem";
import {
  FinalizationBinding,
  FinalizationFilesystem,
  FinalizationChunk,
} from "./ssd-finalization-contract";
import {
  ArtifactIdentity,
  RecoveryFilesystem,
  RecoveryOperation,
} from "./ssd-recovery-contract";

interface Pin {
  path: string;
  fd: number;
  device: string;
  inode: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Descriptor capability for one operation; runtime factories never share its fence.
 * SecureFilesystem requires Linux openat2/RENAME_NOREPLACE; there is no fallback.
 * Directory descriptors retain identities until close, including after rename.
 */
export class IsolatedSsdFinalizationFilesystem
  implements FinalizationFilesystem, RecoveryFilesystem
{
  private readonly record: UploadWorkspaceIdentity;
  private readonly pins: Pin[] = [];
  private source: SecureFilesystem | undefined;
  private target: SecureFilesystem | undefined;
  private binding: Readonly<FinalizationBinding> | undefined;
  private temporaryPin: Pin | undefined;
  private closed = false;
  private published = false;
  private recoveryIdentity: ArtifactIdentity | null | undefined;

  constructor(
    private readonly storage: StorageService,
    private readonly prepared: PreparedSsdWorkspace,
    record: UploadWorkspaceIdentity,
  ) {
    this.record = Object.freeze({ ...record });
  }

  prepare(
    userId: number,
    uploadId: string,
    operationId: string,
  ): FinalizationBinding {
    return this.acquire(userId, uploadId, operationId);
  }

  reopen(operation: RecoveryOperation): void {
    try {
      this.recoveryIdentity = operation.targetIdentity;
      this.acquire(
        operation.userId,
        operation.uploadId,
        operation.id,
        operation.binding,
      );
      const temporary = this.inspectTarget(operation.binding, false);
      let final: { fd: number; identity: ArtifactIdentity } | null = null;
      try {
        final = this.inspectTarget(operation.binding, true);
        if (temporary && final)
          throw new Error("Ambiguous recovery target artifacts");
        const artifact = final ?? temporary;
        if (artifact) {
          this.temporaryPin = {
            path: final
              ? operation.binding.storagePath
              : operation.binding.temporaryPath,
            fd: artifact.fd,
            device: artifact.identity.device,
            inode: artifact.identity.inode,
          };
          this.published = !!final;
        }
      } catch (error) {
        if (temporary) fs.closeSync(temporary.fd);
        if (final) fs.closeSync(final.fd);
        throw error;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private acquire(
    userId: number,
    uploadId: string,
    operationId: string,
    expected?: FinalizationBinding,
  ): FinalizationBinding {
    if (this.closed || this.binding)
      throw new Error("Finalization filesystem already used or closed");
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !uuid.test(uploadId) ||
      !uuid.test(operationId)
    )
      throw new Error("Invalid finalization identity");
    try {
      const sourceRoot = this.prepared.root(this.record);
      this.source = this.prepared.filesystem(this.record);
      const sourcePath = this.prepared.resolve(
        {
          workspaceId: this.record.id,
          uploadId,
          tempPath: path.join(sourceRoot, uploadId),
        },
        this.record,
      );
      const sourceRootPin = this.pinDirectory(sourceRoot, this.source);
      // Independent FD/open description: a live old worker retains its flock
      // even after DB connectivity is lost. Never wait for or steal that lock.
      this.source.lock(sourceRootPin.fd);
      const sourceDirectoryPin = this.pinDirectory(sourcePath, this.source);
      const targetRoot = this.storage.getStoragePath();
      const targetRootFd = fs.openSync(
        targetRoot,
        fs.constants.O_RDONLY |
          fs.constants.O_DIRECTORY |
          fs.constants.O_NOFOLLOW,
      );
      try {
        this.target = new SecureFilesystem(
          targetRoot,
          fs.fstatSync(targetRootFd),
        );
      } finally {
        fs.closeSync(targetRootFd);
      }
      const targetRootPin = this.pinDirectory(targetRoot, this.target);
      if (sourceRootPin.device === targetRootPin.device)
        throw new Error(
          "Finalization requires separate source and target filesystems",
        );
      const targetDirectory = path.join(targetRoot, String(userId));
      this.storage.assertTrustedPath(targetDirectory, true, true);
      if (!expected) this.target.mkdir(targetDirectory);
      const targetDirectoryPin = this.pinDirectory(
        targetDirectory,
        this.target,
      );
      // Persist the directory entry and its own metadata before the journal can
      // refer to the operation. mkdir also syncs its descriptor-relative parent.
      if (!expected) {
        this.target.sync(targetDirectory, true);
        this.target.sync(targetRoot, true);
      }
      const temporaryPath = path.join(
        targetDirectory,
        `.${operationId}.assembling`,
      );
      const storagePath = path.join(
        targetDirectory,
        `${operationId}.ssd-finalized`,
      );
      this.storage.assertTrustedPath(temporaryPath);
      this.storage.assertTrustedPath(storagePath);
      const placement = this.storage.placementForPath(storagePath);
      if (
        placement.storageLocationId !== LEGACY_STORAGE_ID ||
        placement.storagePath !== storagePath
      )
        throw new Error("Unapproved finalization target placement");
      this.binding = Object.freeze({
        sourceWorkspaceId: this.record.id,
        sourceRoot,
        sourcePath,
        sourceDevice: sourceRootPin.device,
        sourceInode: sourceRootPin.inode,
        sourceDirectoryDevice: sourceDirectoryPin.device,
        sourceDirectoryInode: sourceDirectoryPin.inode,
        targetStorageId: placement.storageLocationId,
        targetRoot,
        targetDevice: targetRootPin.device,
        targetInode: targetRootPin.inode,
        targetDirectoryDevice: targetDirectoryPin.device,
        targetDirectoryInode: targetDirectoryPin.inode,
        temporaryPath,
        storagePath,
        relativeObjectKey: placement.relativeObjectKey,
      });
      if (expected) {
        for (const key of Object.keys(
          this.binding,
        ) as (keyof FinalizationBinding)[])
          if (expected[key] !== this.binding[key])
            throw new Error("Recovery journal binding changed");
      }
      this.assertBinding(this.binding);
      return { ...this.binding };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  assertBinding(binding: FinalizationBinding): void {
    if (this.closed || !this.binding || !this.source || !this.target)
      throw new Error("Finalization filesystem unavailable");
    try {
      for (const key of Object.keys(
        this.binding,
      ) as (keyof FinalizationBinding)[])
        if (binding[key] !== this.binding[key])
          throw new Error("Finalization binding changed");
      if (
        this.prepared.root(this.record) !== this.binding.sourceRoot ||
        this.storage.getStoragePath() !== this.binding.targetRoot
      )
        throw new Error("Finalization root changed");
      this.storage.assertPreparedSsdPath(this.binding.sourcePath);
      this.storage.assertTrustedPath(
        path.dirname(this.binding.storagePath),
        true,
        true,
      );
      this.storage.assertTrustedPath(this.binding.temporaryPath);
      this.storage.assertTrustedPath(this.binding.storagePath);
      for (const pin of this.pins) this.assertPin(pin, true);
      const placement = this.storage.placementForPath(this.binding.storagePath);
      if (
        placement.storageLocationId !== this.binding.targetStorageId ||
        placement.relativeObjectKey !== this.binding.relativeObjectKey ||
        placement.storagePath !== this.binding.storagePath
      )
        throw new Error("Finalization placement changed");
      if (this.temporaryPin) {
        this.assertPin(
          {
            ...this.temporaryPin,
            path: this.published
              ? this.binding.storagePath
              : this.binding.temporaryPath,
          },
          false,
        );
      }
    } catch (error) {
      this.close();
      throw new Error("Finalization binding unavailable", { cause: error });
    }
  }

  openChunk(binding: FinalizationBinding, index: number): number {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new Error("Invalid finalization chunk index");
    this.assertBinding(binding);
    const chunk = path.join(binding.sourcePath, String(index));
    this.storage.assertPreparedSsdPath(chunk);
    return this.source!.open(chunk);
  }

  createTemporary(binding: FinalizationBinding): number {
    this.assertBinding(binding);
    if (this.temporaryPin)
      throw new Error("Finalization temporary already created");
    const fd = this.target!.open(binding.temporaryPath, "wx");
    let anchor: number | undefined;
    try {
      this.assertRegularFile(fs.fstatSync(fd, { bigint: true }));
      anchor = this.target!.open(binding.temporaryPath);
      const actual = fs.fstatSync(anchor, { bigint: true });
      const writer = fs.fstatSync(fd, { bigint: true });
      if (writer.dev !== actual.dev || writer.ino !== actual.ino)
        throw new Error("Finalization temporary changed during creation");
      this.temporaryPin = {
        path: binding.temporaryPath,
        fd: anchor,
        device: actual.dev.toString(),
        inode: actual.ino.toString(),
      };
      if (this.recoveryIdentity === null) {
        // This capability exclusively created and pinned the inode. The caller
        // still must durably record it before transitions or publication.
        this.recoveryIdentity = {
          device: actual.dev.toString(),
          inode: actual.ino.toString(),
        };
      }
      // Retain partial bytes on any later error. Recovery may adopt this inode
      // only after recordTarget has durably persisted its exact identity.
      this.target!.sync(path.dirname(binding.temporaryPath), true);
      return fd;
    } catch (error) {
      if (anchor !== undefined) fs.closeSync(anchor);
      this.temporaryPin = undefined;
      fs.closeSync(fd);
      throw error;
    }
  }

  openMetadata(binding: FinalizationBinding): number {
    this.assertBinding(binding);
    if (!this.temporaryPin || this.published) throw new Error("Verified temporary unavailable");
    const fd = this.target!.open(binding.temporaryPath);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.assertRegularFile(stat);
      if (stat.dev.toString() !== this.temporaryPin.device || stat.ino.toString() !== this.temporaryPin.inode)
        throw new Error("Metadata target identity changed");
      return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }

  inspectTarget(
    binding: FinalizationBinding,
    final: boolean,
  ): { fd: number; identity: ArtifactIdentity } | null {
    this.assertBinding(binding);
    let fd: number;
    try {
      fd = this.target!.open(
        final ? binding.storagePath : binding.temporaryPath,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.assertRegularFile(stat);
      const identity = {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
      };
      if (
        this.recoveryIdentity !== undefined &&
        (!this.recoveryIdentity ||
          identity.device !== this.recoveryIdentity.device ||
          identity.inode !== this.recoveryIdentity.inode)
      )
        throw new Error("Unowned recovery target artifact");
      return { fd, identity };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  resetTemporary(
    binding: FinalizationBinding,
    identity: ArtifactIdentity,
  ): number {
    this.assertBinding(binding);
    if (
      this.published ||
      !this.temporaryPin ||
      !this.recoveryIdentity ||
      identity.device !== this.recoveryIdentity.device ||
      identity.inode !== this.recoveryIdentity.inode
    )
      throw new Error("Recovery temporary identity unavailable");
    const fd = this.target!.open(binding.temporaryPath, "rw");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.assertRegularFile(stat);
      if (
        stat.dev.toString() !== identity.device ||
        stat.ino.toString() !== identity.inode
      )
        throw new Error("Recovery temporary identity changed");
      fs.ftruncateSync(fd, 0);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  syncTarget(binding: FinalizationBinding, final: boolean): void {
    this.assertBinding(binding);
    if (!this.temporaryPin || final !== this.published)
      throw new Error("Recovery target durability identity unavailable");
    fs.fsyncSync(this.temporaryPin.fd);
    this.target!.sync(path.dirname(binding.storagePath), true);
    this.assertBinding(binding);
  }

  removeChunk(
    binding: FinalizationBinding,
    part: FinalizationChunk,
    identity: ArtifactIdentity,
  ): void {
    this.assertBinding(binding);
    if (!Number.isSafeInteger(part.chunkIndex) || part.chunkIndex < 0)
      throw new Error("Invalid cleanup chunk index");
    let fd: number;
    try {
      fd = this.openChunk(binding, part.chunkIndex);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.assertRegularFile(stat);
      if (
        stat.dev.toString() !== identity.device ||
        stat.ino.toString() !== identity.inode ||
        stat.size !== BigInt(part.byteSize)
      )
        throw new Error("Cleanup owned chunk identity changed");
      this.source!.removeOwned(
        path.join(binding.sourcePath, String(part.chunkIndex)),
        fd,
      );
    } finally {
      fs.closeSync(fd);
    }
    this.assertBinding(binding);
  }

  syncSource(binding: FinalizationBinding): void {
    this.assertBinding(binding);
    this.source!.sync(binding.sourcePath, true);
    this.source!.sync(binding.sourceRoot, true);
    this.assertBinding(binding);
  }

  publish(binding: FinalizationBinding): void {
    this.assertBinding(binding);
    if (!this.temporaryPin || this.published)
      throw new Error(
        "Finalization temporary unavailable or already published",
      );
    // Caller has already checked manifest/hash/size and fsync'd its writer FD.
    // The retained read descriptor pins that exact inode across writer close.
    this.target!.rename(binding.temporaryPath, binding.storagePath);
    this.published = true;
    this.target!.sync(path.dirname(binding.storagePath), true);
    this.assertBinding(binding);
  }

  private pinDirectory(absolute: string, boundary: SecureFilesystem): Pin {
    const expected = boundary.stat(absolute, true);
    const fd = fs.openSync(
      absolute,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      const acquired = fs.fstatSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      this.assertOwnedDirectory(stat);
      if (expected.dev !== acquired.dev || expected.ino !== acquired.ino)
        throw new Error("Finalization directory changed during pinning");
      const pin = {
        path: absolute,
        fd,
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
      };
      this.assertPin(pin, true);
      this.pins.push(pin);
      return pin;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private assertPin(pin: Pin, directory: boolean): void {
    const current = fs.lstatSync(pin.path, { bigint: true });
    const anchor = fs.fstatSync(pin.fd, { bigint: true });
    if (directory) this.assertOwnedDirectory(current);
    else this.assertRegularFile(current);
    if (
      current.dev.toString() !== pin.device ||
      current.ino.toString() !== pin.inode ||
      anchor.dev.toString() !== pin.device ||
      anchor.ino.toString() !== pin.inode
    )
      throw new Error("Finalization object identity changed");
  }

  private assertOwnedDirectory(stat: fs.BigIntStats): void {
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== BigInt(process.geteuid!()) ||
      (stat.mode & 0o022n) !== 0n
    )
      throw new Error("Untrusted finalization directory");
  }

  private assertRegularFile(stat: fs.BigIntStats): void {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.geteuid!()) ||
      (stat.mode & 0o077n) !== 0n
    )
      throw new Error("Untrusted finalization temporary");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.target?.close();
    for (const pin of this.pins) fs.closeSync(pin.fd);
    if (this.temporaryPin) fs.closeSync(this.temporaryPin.fd);
    // PreparedSsdWorkspace owns and releases the shared source capability.
  }
}
