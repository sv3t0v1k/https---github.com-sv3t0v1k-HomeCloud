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
} from "./ssd-finalization-contract";

interface Pin {
  path: string;
  fd: number;
  device: string;
  inode: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One explicit, isolated operation. No providers/routes, cleanup or recovery.
 * SecureFilesystem requires Linux openat2/RENAME_NOREPLACE; there is no fallback.
 * Directory descriptors retain identities until close, including after rename.
 */
export class IsolatedSsdFinalizationFilesystem implements FinalizationFilesystem {
  private readonly record: UploadWorkspaceIdentity;
  private readonly pins: Pin[] = [];
  private source: SecureFilesystem | undefined;
  private target: SecureFilesystem | undefined;
  private binding: Readonly<FinalizationBinding> | undefined;
  private temporaryPin: Pin | undefined;
  private closed = false;
  private published = false;

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
      this.target.mkdir(targetDirectory);
      const targetDirectoryPin = this.pinDirectory(
        targetDirectory,
        this.target,
      );
      // Persist the directory entry and its own metadata before the journal can
      // refer to the operation. mkdir also syncs its descriptor-relative parent.
      this.target.sync(targetDirectory, true);
      this.target.sync(targetRoot, true);
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
      // The journal already records this exclusive name. Retain partial bytes
      // on any later error; recovery/cleanup is a separately approved stage.
      this.target!.sync(path.dirname(binding.temporaryPath), true);
      return fd;
    } catch (error) {
      if (anchor !== undefined) fs.closeSync(anchor);
      this.temporaryPin = undefined;
      fs.closeSync(fd);
      throw error;
    }
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
