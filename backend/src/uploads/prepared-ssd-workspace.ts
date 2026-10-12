import * as fs from "node:fs";
import * as path from "node:path";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { StorageService } from "../storage/storage.service";
import { SecureFilesystem } from "./secure-filesystem";
import {
  UploadWorkspaceIdentity,
  WorkspaceBoundSession,
} from "./upload-workspace";

/** Preparation capability only: normal session admission remains legacy in Stage 1.
 * No mkdir, enrollment, copy, cleanup or restart recovery. Failure latches until close.
 */
export class PreparedSsdWorkspace {
  private rootFd: number | undefined;
  private pinnedRoot: string | undefined;
  private boundary: SecureFilesystem | undefined;
  private failed = false;
  constructor(private readonly storage: StorageService) {}

  root(record: UploadWorkspaceIdentity | null | undefined): string {
    if (
      !record ||
      record.id !== SSD_UPLOAD_WORKSPACE.id ||
      record.machineKey !== SSD_UPLOAD_WORKSPACE.machineKey ||
      record.mountKey !== SSD_UPLOAD_WORKSPACE.mountKey ||
      record.type !== SSD_UPLOAD_WORKSPACE.type
    )
      throw new Error("Unapproved temporary SSD workspace identity");
    if (this.failed) throw new Error("Temporary SSD workspace unavailable");
    try {
      const root = this.storage.getPreparedSsdRoot();
      if (this.rootFd === undefined) {
        this.storage.assertPreparedSsdPath(root);
        this.rootFd = fs.openSync(
          root,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
        );
        this.pinnedRoot = root;
        this.boundary = new SecureFilesystem(root, fs.fstatSync(this.rootFd));
      }
      const current = fs.lstatSync(root),
        anchor = fs.fstatSync(this.rootFd);
      if (
        root !== this.pinnedRoot ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== anchor.dev ||
        current.ino !== anchor.ino
      )
        throw new Error("Temporary SSD root changed");
      return root;
    } catch (error) {
      this.close();
      throw new Error("Temporary SSD workspace unavailable", { cause: error });
    }
  }

  resolve(
    session: WorkspaceBoundSession,
    record: UploadWorkspaceIdentity,
  ): string {
    const root = this.root(record);
    if (
      session.workspaceId !== record.id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        session.uploadId,
      ) ||
      session.tempPath !== path.join(root, session.uploadId)
    )
      throw new Error("Invalid temporary SSD session binding");
    return this.directory(session.tempPath);
  }

  ingress(record: UploadWorkspaceIdentity): string {
    return this.directory(path.join(this.root(record), "multipart-ingress"));
  }

  filesystem(record: UploadWorkspaceIdentity): SecureFilesystem {
    this.root(record);
    return this.boundary!;
  }

  private directory(absolute: string): string {
    this.storage.assertPreparedSsdPath(absolute);
    try {
      const stat = this.boundary!.stat(absolute, true);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== fs.fstatSync(this.rootFd!).dev
      )
        throw new Error("Invalid temporary SSD directory");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return absolute;
  }

  close(): void {
    this.failed = true;
    this.boundary?.close();
    if (this.rootFd !== undefined) fs.closeSync(this.rootFd);
    this.rootFd = undefined;
  }
}
