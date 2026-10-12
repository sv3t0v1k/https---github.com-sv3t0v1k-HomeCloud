import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SSD_UPLOAD_WORKSPACE,
  LEGACY_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";
import { StorageService } from "../storage/storage.service";
import { PreparedSsdWorkspace } from "./prepared-ssd-workspace";

// Portable contract test only; does not qualify Linux openat2 or physical mounts.
jest.mock("./secure-filesystem", () => ({
  SecureFilesystem: class {
    constructor(readonly root: string) {}
    stat(target: string) {
      return fs.lstatSync(target);
    }
    close() {}
  },
}));

describe("prepared SSD workspace contract without session admission", () => {
  let root: string, workspace: PreparedSsdWorkspace;
  const id = "12345678-1234-4234-8234-123456789abc";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-ssd-workspace-"));
    workspace = new PreparedSsdWorkspace({
      getPreparedSsdRoot: () => root,
      assertPreparedSsdPath: (target: string) => target,
    } as unknown as StorageService);
  });
  afterEach(() => {
    workspace.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root + ".old", { recursive: true, force: true });
  });
  it("resolves approved SSD ingress and bound session labels without creating bytes", () => {
    expect(workspace.root(SSD_UPLOAD_WORKSPACE)).toBe(root);
    expect(workspace.ingress(SSD_UPLOAD_WORKSPACE)).toBe(
      path.join(root, "multipart-ingress"),
    );
    expect(
      workspace.resolve(
        {
          workspaceId: SSD_UPLOAD_WORKSPACE.id,
          uploadId: id,
          tempPath: path.join(root, id),
        },
        SSD_UPLOAD_WORKSPACE,
      ),
    ).toBe(path.join(root, id));
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("rejects DB identity substitution and path/session mismatches", () => {
    expect(() => workspace.root(LEGACY_UPLOAD_WORKSPACE)).toThrow("Unapproved");
    expect(() =>
      workspace.root({ ...SSD_UPLOAD_WORKSPACE, mountKey: "wrong" }),
    ).toThrow("Unapproved");
    expect(() =>
      workspace.resolve(
        {
          workspaceId: SSD_UPLOAD_WORKSPACE.id,
          uploadId: id,
          tempPath: root + "/other",
        },
        SSD_UPLOAD_WORKSPACE,
      ),
    ).toThrow("binding");
    expect(() =>
      workspace.resolve(
        {
          workspaceId: LEGACY_UPLOAD_WORKSPACE.id,
          uploadId: id,
          tempPath: path.join(root, id),
        },
        SSD_UPLOAD_WORKSPACE,
      ),
    ).toThrow("binding");
    expect(() =>
      workspace.resolve(
        {
          workspaceId: SSD_UPLOAD_WORKSPACE.id,
          uploadId: "../outside",
          tempPath: root + "/../outside",
        },
        SSD_UPLOAD_WORKSPACE,
      ),
    ).toThrow("binding");
  });
  it("latches root replacement and releases the anchor on failure", () => {
    workspace.root(SSD_UPLOAD_WORKSPACE);
    fs.renameSync(root, root + ".old");
    fs.mkdirSync(root);
    expect(() => workspace.filesystem(SSD_UPLOAD_WORKSPACE)).toThrow(
      "unavailable",
    );
    fs.rmdirSync(root);
    fs.renameSync(root + ".old", root);
    expect(() => workspace.root(SSD_UPLOAD_WORKSPACE)).toThrow("unavailable");
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
