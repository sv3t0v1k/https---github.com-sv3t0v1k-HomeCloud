import { ConfigService } from "@nestjs/config";
import fs from "fs";
import * as os from "os";
import * as path from "path";
import { StorageService } from "../storage/storage.service";
import {
  LEGACY_UPLOAD_WORKSPACE,
  LEGACY_UPLOAD_WORKSPACE_ID,
  UploadWorkspaceResolver,
} from "./upload-workspace";

const uploadId = "12345678-1234-4234-8234-123456789abc";

describe("UploadWorkspaceResolver legacy binding", () => {
  let storageRoot: string;
  let workspaceRoot: string;
  let storage: StorageService;
  let resolver: UploadWorkspaceResolver;
  const record = { ...LEGACY_UPLOAD_WORKSPACE };
  const session = () => ({
    workspaceId: LEGACY_UPLOAD_WORKSPACE_ID,
    uploadId,
    tempPath: path.join(workspaceRoot, uploadId),
  });

  beforeEach(() => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-workspace-"));
    workspaceRoot = path.join(storageRoot, ".tmp");
    storage = new StorageService({
      get: (key: string) => (key === "STORAGE_PATH" ? storageRoot : undefined),
    } as ConfigService);
    resolver = new UploadWorkspaceResolver(storage);
  });

  afterEach(() => {
    resolver.close();
    storage.onModuleDestroy();
    jest.restoreAllMocks();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it("derives only the operator root and preserves exact session/chunk bytes", () => {
    const directory = session().tempPath;
    fs.mkdirSync(directory);
    const bytes = Buffer.from([0, 255, 3, 7]);
    fs.writeFileSync(path.join(directory, "part-1"), bytes);
    expect(resolver.root(record)).toBe(workspaceRoot);
    expect(resolver.resolve(session(), record)).toBe(directory);
    expect(resolver.ingress(record)).toBe(
      path.join(workspaceRoot, "multipart-ingress"),
    );
    expect(fs.readFileSync(path.join(directory, "part-1"))).toEqual(bytes);
  });

  it.each([
    null,
    undefined,
    { ...record, id: "unknown" },
    { ...record, machineKey: "other" },
    { ...record, mountKey: "other" },
    { ...record, type: "remote" },
  ])(
    "refuses missing or unapproved database record %j without fallback",
    (row) => {
      expect(() => resolver.resolve(session(), row)).toThrow(
        "Unapproved upload workspace identity",
      );
      expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    },
  );

  it("refuses workspace binding and retained path bridge mismatches", () => {
    expect(() =>
      resolver.resolve({ ...session(), workspaceId: "other" }, record),
    ).toThrow("session binding");
    expect(() =>
      resolver.resolve({ ...session(), tempPath: storageRoot }, record),
    ).toThrow("path mismatch");
    expect(() =>
      resolver.resolve({ ...session(), uploadId: "../outside" }, record),
    ).toThrow("session binding");
    expect(() =>
      resolver.assertPath(path.join(storageRoot, "outside")),
    ).toThrow("temporary path");
  });

  it("permits missing terminal session directory without creating it", () => {
    expect(resolver.resolve(session(), record)).toBe(session().tempPath);
    expect(fs.existsSync(session().tempPath)).toBe(false);
  });

  it("rejects a missing workspace even on first use and never recreates it", () => {
    fs.rmdirSync(workspaceRoot);
    expect(() => resolver.root(record)).toThrow("root unavailable");
    expect(fs.existsSync(workspaceRoot)).toBe(false);
  });

  it("fails closed after workspace disappearance even if it returns", () => {
    resolver.root(record);
    fs.renameSync(workspaceRoot, path.join(storageRoot, "saved-workspace"));
    expect(() => resolver.ingress(record)).toThrow("root unavailable");
    expect(fs.existsSync(workspaceRoot)).toBe(false);
    fs.renameSync(path.join(storageRoot, "saved-workspace"), workspaceRoot);
    expect(() => resolver.root(record)).toThrow("root unavailable");
  });

  it("detects same-FS workspace replacement and never repins", () => {
    resolver.root(record);
    fs.renameSync(workspaceRoot, path.join(storageRoot, "saved-workspace"));
    fs.mkdirSync(workspaceRoot);
    expect(() => resolver.resolve(session(), record)).toThrow(
      "root unavailable",
    );
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
  });

  it("refuses symbolic workspace and session/ingress directories", () => {
    resolver.root(record);
    fs.mkdirSync(path.join(storageRoot, "target"));
    fs.symlinkSync(path.join(storageRoot, "target"), session().tempPath);
    expect(() => resolver.resolve(session(), record)).toThrow();
    fs.symlinkSync(
      path.join(storageRoot, "target"),
      path.join(workspaceRoot, "multipart-ingress"),
    );
    expect(() => resolver.ingress(record)).toThrow();
    fs.renameSync(workspaceRoot, path.join(storageRoot, "saved-workspace"));
    fs.symlinkSync(path.join(storageRoot, "saved-workspace"), workspaceRoot);
    expect(() => resolver.root(record)).toThrow("root unavailable");
  });

  it("requires actual ingress/chunks directories and same filesystem", () => {
    const ingress = resolver.ingress(record);
    fs.mkdirSync(ingress);
    fs.mkdirSync(session().tempPath);
    expect(() =>
      resolver.assertColocated(session().tempPath, ingress),
    ).not.toThrow();
    const actual = fs.lstatSync;
    jest.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      const stat = actual(target, options as { bigint?: false });
      return target === ingress
        ? Object.assign(stat, { dev: stat.dev + 1 })
        : stat;
    });
    expect(() =>
      resolver.assertColocated(session().tempPath, ingress),
    ).toThrow();
  });

  it("reuses MS-2 admission before each operation and propagates mount failure", () => {
    resolver.root(record);
    const guard = jest.spyOn(storage, "assertTemporaryPath");
    resolver.assertPath(path.join(session().tempPath, "part-2"));
    expect(guard).toHaveBeenCalledWith(workspaceRoot);
    expect(guard).toHaveBeenCalledWith(path.join(session().tempPath, "part-2"));
    guard.mockImplementation(() => {
      throw new Error("nested mount rejected");
    });
    expect(() => resolver.ingress(record)).toThrow("root unavailable");
  });

  it("refuses non-directory ingress and session objects", () => {
    fs.writeFileSync(session().tempPath, "not-directory");
    expect(() => resolver.resolve(session(), record)).toThrow("directory");
    fs.writeFileSync(
      path.join(workspaceRoot, "multipart-ingress"),
      "not-directory",
    );
    expect(() => resolver.ingress(record)).toThrow("directory");
  });

  it("releases its root anchor and refuses subsequent reuse", () => {
    resolver.root(record);
    resolver.close();
    expect(() => resolver.root(record)).toThrow("root unavailable");
  });
});
