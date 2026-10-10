import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "./storage.service";
import { StorageRegistry, validateObjectKey } from "./storage-placement";
import {
  ApprovedRoot,
  IDENTITY_MARKER,
  LEGACY_STORAGE_ID,
  StorageMountRegistry,
  legacyBinding,
  linuxMountIdentity,
  markerContents,
  bootstrapLegacyMarker,
} from "./storage-mount-registry";
import { abortableDiskStorage } from "../uploads/abortable-disk-storage";

const otherId = "a2e8a3b0-8d57-4c49-9f8c-0d095b344602";
function mountLine(
  root: string,
  options = "rw",
  superOptions = "rw",
  id = "12",
) {
  const escape = (s: string) =>
    s.replace(/\\/g, "\\134").replace(/ /g, "\\040");
  return `${id} 1 8:1 /volume ${escape(root)} ${options} shared:1 - ext4 /dev/test ${superOptions}`;
}

describe("operator storage bindings and identity fail closed", () => {
  let root: string;
  let binding: ApprovedRoot;
  let mountinfo: string;
  let platform: PropertyDescriptor;
  let registries: StorageMountRegistry[];
  let services: StorageService[];
  let previousNodeEnv: string | undefined;
  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    registries = []; services = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-registry-"));
    binding = legacyBinding(root, true);
    fs.writeFileSync(
      path.join(root, IDENTITY_MARKER),
      markerContents(binding),
      { mode: 0o600 },
    );
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    mountinfo = mountLine(root);
    const actualRead = fs.readFileSync;
    jest
      .spyOn(fs, "readFileSync")
      .mockImplementation(((target: any, ...args: any[]) =>
        target === "/proc/self/mountinfo"
          ? mountinfo
          : (actualRead as any)(target, ...args)) as any);
  });
  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    jest.restoreAllMocks();
    for (const registry of registries) registry.close();
    for (const service of services) service.onModuleDestroy();
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root + ".old", { recursive: true, force: true });
  });
  const make = (b: ApprovedRoot) => { const registry = new StorageMountRegistry([b]); registries.push(registry); return registry; };
  it.each(["../disk", "/disk", "Bad key", "disk--two", "disk-"])(
    "rejects unapproved malformed mount key %s",
    (mountKey) => {
      expect(() => make({ ...binding, mountKey })).toThrow();
    },
  );
  it("rejects roots, duplicates and DB identity/key mismatch without accepting DB paths", () => {
    for (const unsafe of [
      "/",
      "relative",
      root + "/../disk",
      root + "\\disk",
      root + "\0",
    ])
      expect(() => make({ ...binding, root: unsafe })).toThrow();
    expect(() => new StorageMountRegistry([binding, binding])).toThrow();
    expect(() => make(binding).approved(LEGACY_STORAGE_ID, "wrong")).toThrow();
    expect(() => make(binding).approved(otherId)).toThrow();
  });
  it("pins root/marker/mount and performs actual exclusive fd write/read/sync/cleanup diagnostic", () => {
    const registry = make(binding);
    const before = fs.readdirSync(root);
    expect(registry.inspect(binding.id, true)).toMatchObject({
      state: "online",
      capabilities: { read: true, write: true, secureOpen: false },
    });
    expect(fs.readdirSync(root)).toEqual(before);
    expect(() => registry.openSecure(binding.id)).toThrow(
      "Secure descriptor",
    );
  });
  it("releases identity anchors at shutdown and refuses reuse of a closed registry", () => {
    const registry = make(binding);
    registry.assertAccess(binding.id);
    registry.close(); registry.close();
    expect(() => registry.assertAccess(binding.id)).toThrow("closed");
  });
  it("missing root never gets created; ordinary empty directory is not a mount", () => {
    mountinfo = mountLine("/some-other-root");
    const registry = make(binding);
    expect(registry.inspect(binding.id, true).state).toBe("offline");
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
    fs.rmSync(root, { recursive: true });
    expect(registry.inspect(binding.id, true).state).toBe("offline");
    expect(fs.existsSync(root)).toBe(false);
  });
  it.each(["absent", "wrong", "swapped", "symlink"])(
    "rejects %s marker before a write probe",
    (mode) => {
      const registry = make(binding);
      registry.assertAccess(binding.id);
      const marker = path.join(root, IDENTITY_MARKER);
      fs.unlinkSync(marker);
      if (mode === "wrong") fs.writeFileSync(marker, "wrong");
      if (mode === "swapped") fs.writeFileSync(marker, markerContents(binding));
      if (mode === "symlink") fs.symlinkSync("/etc/passwd", marker);
      expect(registry.inspect(binding.id, true).state).toBe(
        "identity-mismatch",
      );
      expect(
        fs.readdirSync(root).filter((n) => n.startsWith(".hc-probe-")),
      ).toEqual([]);
    },
  );
  it("rejects a FIFO marker without blocking on open", () => {
    fs.unlinkSync(path.join(root, IDENTITY_MARKER));
    execFileSync("mkfifo", [path.join(root, IDENTITY_MARKER)]);
    expect(make(binding).inspect(binding.id, true).state).toBe("identity-mismatch");
  });
  it("rejects a nested bind mount even on the same device", () => {
    mountinfo += "\n" + mountLine(root + "/child", "rw", "rw", "99");
    expect(make(binding).inspect(binding.id, true).state).toBe("offline");
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
  });
  it.each(["rw ro", "ro rw"])(
    "recognizes mount AND superblock read-only options %s",
    (pair) => {
      const [options, superOptions] = pair.split(" ");
      mountinfo = mountLine(root, options, superOptions);
      expect(make(binding).inspect(binding.id, true)).toMatchObject({
        state: "read-only",
        capabilities: { read: true, write: false },
      });
      expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
    },
  );
  it("detects changed mount identity and never repins after failure", () => {
    const registry = make(binding);
    registry.assertAccess(binding.id);
    mountinfo = mountLine(root, "rw", "rw", "13");
    expect(registry.inspect(binding.id).state).toBe("identity-mismatch");
    expect(registry.inspect(binding.id).state).toBe("identity-mismatch");
    mountinfo = mountLine(root);
    expect(registry.inspect(binding.id).state).toBe("online");
  });
  it("refuses unknown/non-Linux adapters and stacked exact mounts", () => {
    mountinfo += "\n" + mountLine(root, "rw", "rw", "99");
    expect(make(binding).inspect(binding.id).state).toBe("offline");
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(make(binding).inspect(binding.id)).toMatchObject({
      state: "degraded",
      capabilities: { write: false },
    });
  });
  it("does not classify unreadable directories as readable, and reports denied writes", () => {
    jest.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(make(binding).inspect(binding.id)).toMatchObject({
      state: "degraded",
      capabilities: { read: false, write: false },
    });
    jest.restoreAllMocks();
  });
  it("diagnoses probe failure/cleanup failure without swallowing errors as online", () => {
    const actualOpen = fs.openSync;
    jest.spyOn(fs, "openSync").mockImplementation(((
      target: any,
      ...args: any[]
    ) => {
      if (String(target).includes(".hc-probe-"))
        throw Object.assign(new Error("read-only"), { code: "EROFS" });
      return (actualOpen as any)(target, ...args);
    }) as any);
    expect(make(binding).inspect(binding.id, true).state).toBe("read-only");
    jest.spyOn(fs, "openSync").mockImplementation(actualOpen);
    jest.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("IO"), { code: "EIO" });
    });
    expect(make(binding).inspect(binding.id, true).state).toBe("degraded");
  });
  it("operator extra bindings are diagnostic-only and cannot be promoted by a trusted flag", () => {
    const extra = {
      ...binding,
      id: otherId,
      machineKey: "disk-two",
      mountKey: "disk-two",
      profile: "blocked" as const,
    };
    fs.writeFileSync(path.join(root, IDENTITY_MARKER), markerContents(extra));
    const registry = make(extra);
    expect(registry.inspect(extra.id, true)).toMatchObject({
      state: "degraded",
      reason: "secure-open-unavailable",
      capabilities: { read: false, write: false },
    });
    expect(() => registry.assertAccess(extra.id)).toThrow();
    expect(() => make({ ...extra, profile: "trusted-legacy" })).toThrow();
    expect(() => new StorageRegistry(root, true, [extra])).toThrow();
  });
  it("bootstrap refuses existing marker and plain directories without creating roots", () => {
    expect(() => bootstrapLegacyMarker(root)).toThrow();
    fs.unlinkSync(path.join(root, IDENTITY_MARKER));
    mountinfo = "";
    expect(() => bootstrapLegacyMarker(root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    mountinfo = mountLine(root);
    bootstrapLegacyMarker(root);
    expect(make(binding).inspect(binding.id).state).toBe("online");
  });
  it("refuses production startup with missing upload workspace without recreating it", () => {
    expect(() => new StorageService(new ConfigService({ STORAGE_PATH: root, NODE_ENV: "production" })))
      .toThrow("Upload workspace unavailable");
    expect(fs.existsSync(root + "/.tmp")).toBe(false);
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
  });
  it("reused real service denies create/write/copy/delete/read/temp and Multer after observed root replacement", async () => {
    fs.mkdirSync(root + "/.tmp");
    const service = new StorageService(
      new ConfigService({ STORAGE_PATH: root, NODE_ENV: "production" }),
    );
    services.push(service);
    const target = service.generatePath(1, "original");
    await service.writeFile(target, Buffer.from("preserve"));
    fs.renameSync(root, root + ".old");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, IDENTITY_MARKER), markerContents(binding));
    expect(service.storageDiagnostic(true).state).toBe("identity-mismatch");
    expect(() => service.generatePath(1, "new")).toThrow();
    expect(() => service.generateFinalPath(1, "uuid", "new")).toThrow();
    expect(() => service.getTempPath()).toThrow();
    expect(() => service.getStorageUsage(1)).toThrow();
    expect(() => service.getFileSize(target)).toThrow();
    await expect(
      service.writeFile(root + "/new", Buffer.from("bad")),
    ).rejects.toThrow();
    await expect(service.copyFile(target, root + "/copy")).rejects.toThrow();
    await expect(service.deleteFile(target)).rejects.toThrow();
    await expect(service.readFile(target)).rejects.toThrow();
    const engine = abortableDiskStorage(
      root + "/.tmp/multipart-ingress",
      (p) => {
        service.assertTrustedPath(p);
      },
    );
    const callback = jest.fn();
    engine._handleFile(
      {} as any,
      { stream: Readable.from("bytes") } as any,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
    expect(fs.readFileSync(root + ".old/1/original", "utf8")).toBe("preserve");
  });
  it("rejects static workspace/ordinary ancestor symlink, marker keys and permissive directories", async () => {
    fs.mkdirSync(root + "/.tmp");
    const service = new StorageService(
      new ConfigService({ STORAGE_PATH: root, NODE_ENV: "production" }),
    );
    services.push(service);
    fs.mkdirSync(root + "/outside");
    expect(() => service.assertTemporaryPath(root + "/outside")).toThrow();
    fs.symlinkSync(root + "/outside", root + "/.tmp/link");
    expect(() => service.assertTrustedPath(root + "/.tmp/link/new")).toThrow();
    expect(() =>
      service.assertTrustedPath(root + "/.tmp/../outside/new"),
    ).toThrow();
    fs.symlinkSync("/tmp", root + "/1");
    await expect(
      service.writeFile(root + "/1/escape", Buffer.from("bad")),
    ).rejects.toThrow();
    expect(() => service.getStorageUsage(1)).toThrow();
    for (const key of [IDENTITY_MARKER, ".hc-probe-any", ".tmp/one"])
      expect(() => validateObjectKey(key)).toThrow();
    fs.mkdirSync(root + "/permissive", { mode: 0o777 });
    fs.chmodSync(root + "/permissive", 0o777);
    expect(() => service.assertTrustedPath(root + "/permissive/new")).toThrow();
  });
});

describe("Linux mountinfo parsing", () => {
  it("decodes escaped spaces/backslashes and ignores containing root/optional fields", () => {
    const root = "/storage disk\\special";
    expect(linuxMountIdentity(root, mountLine(root))).toMatchObject({
      readOnly: false,
    });
    expect(
      linuxMountIdentity("/storage/child", mountLine("/storage")),
    ).toBeUndefined();
    expect(() => linuxMountIdentity("/storage", "malformed")).toThrow();
  });
});
