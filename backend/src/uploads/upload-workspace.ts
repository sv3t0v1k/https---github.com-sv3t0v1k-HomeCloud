import * as fs from "fs";
import * as path from "path";
import { StorageService } from "../storage/storage.service";

import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  LEGACY_UPLOAD_WORKSPACE_KEY,
  LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY,
} from "../entities/upload-workspace.entity";
export {
  LEGACY_UPLOAD_WORKSPACE_ID,
  LEGACY_UPLOAD_WORKSPACE_KEY,
  LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY,
  LEGACY_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";

export interface UploadWorkspaceIdentity {
  id: string;
  machineKey: string;
  mountKey: string;
  type: string;
}

export interface WorkspaceBoundSession {
  workspaceId: string;
  uploadId: string;
  tempPath: string;
}

/**
 * MS-3A operator approval: only the existing legacy .tmp is admitted.
 * Database paths never select a workspace. Revalidation detects observable
 * replacement; legacy pathname I/O still has TOCTOU races (no openat2).
 */
export class UploadWorkspaceResolver {
  private legacyRoot!: string;
  private rootDevice!: number;
  private rootInode!: number;
  private rootFd: number | undefined;
  private failed = false;

  constructor(private readonly storage: StorageService) {}

  onModuleDestroy(): void {
    this.close();
  }

  close(): void {
    this.failed = true;
    if (this.rootFd !== undefined) {
      fs.closeSync(this.rootFd);
      this.rootFd = undefined;
    }
  }

  validate(record: UploadWorkspaceIdentity | null | undefined): void {
    if (
      !record ||
      record.id !== LEGACY_UPLOAD_WORKSPACE_ID ||
      record.machineKey !== LEGACY_UPLOAD_WORKSPACE_KEY ||
      record.mountKey !== LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY ||
      record.type !== "local_filesystem"
    ) {
      throw new Error("Unapproved upload workspace identity");
    }
    this.assertRoot();
  }

  root(record: UploadWorkspaceIdentity): string {
    this.validate(record);
    return this.legacyRoot;
  }

  resolve(
    session: WorkspaceBoundSession,
    record: UploadWorkspaceIdentity | null | undefined,
  ): string {
    this.validate(record);
    if (
      session.workspaceId !== record!.id ||
      typeof session.uploadId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        session.uploadId,
      )
    ) {
      throw new Error("Invalid upload workspace session binding");
    }
    const expected = path.join(this.legacyRoot, session.uploadId);
    if (session.tempPath !== expected) {
      throw new Error("Upload workspace session path mismatch");
    }
    this.assertDirectory(expected, true);
    return expected;
  }

  ingress(record: UploadWorkspaceIdentity): string {
    this.validate(record);
    const ingress = path.join(this.legacyRoot, "multipart-ingress");
    this.assertDirectory(ingress, true);
    return ingress;
  }

  /** Call immediately before direct pathname I/O; missing child paths allowed. */
  assertPath(absolute: string): string {
    this.assertRoot();
    return this.storage.assertTemporaryPath(absolute);
  }

  /** rename adoption requires ingress and chunks on this same legacy FS. */
  assertColocated(sessionPath: string, ingressPath: string): void {
    this.assertDirectory(sessionPath, false);
    this.assertDirectory(ingressPath, false);
    if (
      fs.lstatSync(sessionPath).dev !== this.rootDevice ||
      fs.lstatSync(ingressPath).dev !== this.rootDevice
    ) {
      throw new Error("Upload workspace ingress and chunks are not colocated");
    }
  }

  private assertDirectory(absolute: string, allowMissing: boolean): void {
    this.assertPath(absolute);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Unsafe upload workspace directory");
      }
      if (stat.dev !== this.rootDevice) {
        throw new Error("Upload workspace filesystem mismatch");
      }
    } catch (error) {
      if (allowMissing && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private assertRoot(): void {
    if (this.failed) {
      throw new Error("Upload workspace root unavailable");
    }
    try {
      if (this.rootFd === undefined) {
        this.legacyRoot = this.storage.getTempPath();
        this.storage.assertTemporaryPath(this.legacyRoot);
        const initial = fs.lstatSync(this.legacyRoot);
        if (!initial.isDirectory() || initial.isSymbolicLink()) {
          throw new Error("Upload workspace root unavailable");
        }
        this.rootDevice = initial.dev;
        this.rootInode = initial.ino;
        this.rootFd = fs.openSync(
          this.legacyRoot,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
      }
      // MS-2 additionally qualifies the storage mount, root/marker identity,
      // child ownership, symlinks and nested mounts in production.
      if (this.storage.getTempPath() !== this.legacyRoot) {
        throw new Error("Upload workspace root path changed");
      }
      this.storage.assertTemporaryPath(this.legacyRoot);
      const current = fs.lstatSync(this.legacyRoot);
      const anchor = fs.fstatSync(this.rootFd);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== this.rootDevice ||
        current.ino !== this.rootInode ||
        anchor.dev !== this.rootDevice ||
        anchor.ino !== this.rootInode
      ) {
        throw new Error("Upload workspace root identity changed");
      }
    } catch (error) {
      this.failed = true;
      throw new Error("Upload workspace root unavailable", { cause: error });
    }
  }
}
