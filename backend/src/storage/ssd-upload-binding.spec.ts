import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigService } from "@nestjs/config";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { ssdUploadBinding } from "./ssd-upload-binding";
import {
  IDENTITY_MARKER,
  StorageMountRegistry,
  linuxMountIdentity,
  markerContents,
} from "./storage-mount-registry";
import { StorageService } from "./storage.service";

describe("temporary SSD preparation, trusted personal server", () => {
  let root: string,
    permanent: string,
    registry: StorageMountRegistry | undefined;
  let mountinfo: string, platform: PropertyDescriptor;
  let service: StorageService | undefined;
  const config = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      STORAGE_PATH: permanent,
      UPLOAD_SSD_PATH: root,
      UPLOAD_SSD_MOUNT_SOURCE: "/dev/test-ssd",
      UPLOAD_SSD_MOUNT_ROOT: "/",
      UPLOAD_SSD_FS_TYPE: "ext4",
      ...overrides,
    };
    return { get: (key: string) => values[key] } as ConfigService;
  };
  const line = (
    mountRoot = root,
    source = "/dev/test-ssd",
    fsRoot = "/",
    options = "rw",
  ) => `12 1 8:2 ${fsRoot} ${mountRoot} ${options} - ext4 ${source} ${options}`;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-prepared-ssd-"));
    permanent = fs.mkdtempSync(path.join(os.tmpdir(), "hc-prepared-hdd-"));
    fs.writeFileSync(
      path.join(root, IDENTITY_MARKER),
      markerContents(ssdUploadBinding(config(), permanent)!),
      { mode: 0o600 },
    );
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    mountinfo = line();
    const actual = fs.readFileSync;
    jest
      .spyOn(fs, "readFileSync")
      .mockImplementation(((target: any, ...args: any[]) =>
        target === "/proc/self/mountinfo"
          ? mountinfo
          : (actual as any)(target, ...args)) as any);
  });
  afterEach(() => {
    registry?.close();
    registry = undefined;
    service?.onModuleDestroy();
    service = undefined;
    jest.restoreAllMocks();
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root + ".old", { recursive: true, force: true });
    fs.rmSync(permanent, { recursive: true, force: true });
  });
  const make = () =>
    (registry = new StorageMountRegistry([
      ssdUploadBinding(config(), permanent)!,
    ]));
  it("requires complete operator mapping and disjoint roots; optional means absent", () => {
    expect(
      ssdUploadBinding(
        { get: () => undefined } as unknown as ConfigService,
        permanent,
      ),
    ).toBeUndefined();
    expect(() =>
      ssdUploadBinding(config({ UPLOAD_SSD_FS_TYPE: undefined }), permanent),
    ).toThrow("Incomplete");
    for (const unsafe of [
      permanent,
      permanent + "/ssd",
      path.dirname(permanent),
      "relative",
      root + "/../ssd",
    ])
      expect(() =>
        ssdUploadBinding(config({ UPLOAD_SSD_PATH: unsafe }), permanent),
      ).toThrow();
    expect(() =>
      ssdUploadBinding(config({ UPLOAD_SSD_FS_TYPE: "nfs" }), permanent),
    ).toThrow();
  });
  it("checks mount source and bind filesystem root across registry restart", () => {
    expect(make().inspect(SSD_UPLOAD_WORKSPACE.id)).toMatchObject({
      state: "online",
      capabilities: { read: true, write: true, secureOpen: false },
    });
    registry!.close();
    registry = undefined;
    mountinfo = line(root, "/dev/wrong");
    expect(
      make().inspect(SSD_UPLOAD_WORKSPACE.id, true).capabilities.write,
    ).toBe(false);
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
    expect(
      linuxMountIdentity(
        root,
        line(root, "/dev/test-ssd", "/wrong"),
        ssdUploadBinding(config(), permanent)!.expectedMount,
      ),
    ).toBeUndefined();
  });
  it.each(["absent", "nested", "read-only", "wrong-marker", "replaced"])(
    "refuses %s without creating directories or probe bytes",
    (failure) => {
      const r = make();
      r.assertAccess(SSD_UPLOAD_WORKSPACE.id, true);
      if (failure === "absent") mountinfo = line("/another-root");
      if (failure === "nested") mountinfo += "\n" + line(root + "/child");
      if (failure === "read-only")
        mountinfo = line(root, "/dev/test-ssd", "/", "ro");
      if (failure === "wrong-marker")
        fs.writeFileSync(path.join(root, IDENTITY_MARKER), "wrong");
      if (failure === "replaced") {
        fs.renameSync(root, root + ".old");
        fs.mkdirSync(root);
      }
      expect(r.inspect(SSD_UPLOAD_WORKSPACE.id, true).capabilities.write).toBe(
        false,
      );
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith(".hc-probe-")),
      ).toEqual([]);
      expect(fs.existsSync(path.join(root, "multipart-ingress"))).toBe(false);
    },
  );
  it("preserves HDD-only File resolution and legacy temp root even with unavailable SSD", () => {
    mountinfo = line("/another-root");
    service = new StorageService(config());
    expect(service.getTempPath()).toBe(path.join(permanent, ".tmp"));
    const file = path.join(permanent, "existing.bin");
    fs.writeFileSync(file, "existing");
    const placement = service.placementForPath(file);
    expect(service.resolveFilePath(placement)).toBe(file);
    expect(() =>
      service!.resolveFilePath({
        ...placement,
        storageLocationId: SSD_UPLOAD_WORKSPACE.id,
      }),
    ).toThrow();
    expect(() => service!.getPreparedSsdRoot()).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("existing");
  });
  it("rejects a second bind/directory on the HDD filesystem", () => {
    service = new StorageService(config());
    expect(() => service!.getPreparedSsdRoot()).toThrow("separate filesystem");
    expect(fs.readdirSync(root)).toEqual([IDENTITY_MARKER]);
  });
  it("confines SSD paths, rejecting symlink children and traversal", () => {
    service = new StorageService(config());
    const actual = fs.lstatSync;
    jest.spyOn(fs, "lstatSync").mockImplementation(((
      target: any,
      ...args: any[]
    ) => {
      const stat = (actual as any)(target, ...args);
      return target === permanent
        ? Object.assign(stat, { dev: stat.dev + 1 })
        : stat;
    }) as any);
    expect(service.assertPreparedSsdPath(root + "/missing/chunk")).toBe(
      root + "/missing/chunk",
    );
    fs.symlinkSync(permanent, root + "/link");
    expect(() =>
      service!.assertPreparedSsdPath(root + "/link/chunk"),
    ).toThrow();
    expect(() =>
      service!.assertPreparedSsdPath(root + "/../outside"),
    ).toThrow();
  });
});
