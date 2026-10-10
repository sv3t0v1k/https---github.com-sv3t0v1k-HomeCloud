import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const LEGACY_STORAGE_ID = "f2f5c4b0-8d57-4c49-9f8c-0d095b344601";
export const LEGACY_STORAGE_KEY = "legacy-storage";
export const IDENTITY_MARKER = ".homecloud-storage-identity";
export type StorageState =
  "online" | "read-only" | "offline" | "identity-mismatch" | "degraded";
export interface ApprovedRoot {
  readonly id: string;
  readonly machineKey: string;
  readonly mountKey: string;
  readonly root: string;
  readonly writable: boolean;
  readonly profile: "trusted-legacy" | "blocked";
  readonly requireMount: boolean;
  readonly requireMarker: boolean;
}
export interface MountIdentity {
  fingerprint: string;
  readOnly: boolean;
}
export interface StorageDiagnostic {
  id: string;
  state: StorageState;
  reason: string;
  capabilities: {
    logicalResolution: boolean;
    secureOpen: false;
    read: boolean;
    write: boolean;
  };
}

const keyPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function validateRoot(root: string): void {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    root !== path.resolve(root) ||
    root === path.parse(root).root ||
    root.includes("\\") ||
    root.includes("\0") ||
    Array.from(root).some((c) => {
      const n = c.codePointAt(0)!;
      return n >= 0xd800 && n <= 0xdfff;
    })
  )
    throw new Error("Invalid storage root");
}

/** Exact namespace mountpoint, not a containing filesystem or physical disk proof. */
export function linuxMountIdentity(
  root: string,
  mountinfo: string,
): MountIdentity | undefined {
  const decode = (value: string) =>
    value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
  const entries = mountinfo
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      if (separator < 6 || fields.length < separator + 4)
        throw new Error("Invalid mountinfo");
      return { fields, separator };
    });
  // A nested bind mount can share st_dev; directory ownership/realpath cannot detect it.
  if (entries.some(({ fields }) => decode(fields[4]).startsWith(root + path.sep))) return undefined;
  const matches = entries.filter(({ fields }) => decode(fields[4]) === root);
  if (matches.length !== 1) return undefined;
  const { fields: f, separator: s } = matches[0];
  return {
    fingerprint: JSON.stringify([
      f[0],
      f[1],
      f[2],
      decode(f[3]),
      decode(f[4]),
      f[s + 1],
      decode(f[s + 2]),
    ]),
    readOnly:
      f[5].split(",").includes("ro") || f[s + 3].split(",").includes("ro"),
  };
}

export function markerContents(
  binding: Pick<ApprovedRoot, "id" | "machineKey" | "mountKey">,
): string {
  return (
    JSON.stringify({
      version: 1,
      storageLocationId: binding.id,
      machineKey: binding.machineKey,
      mountKey: binding.mountKey,
    }) + "\n"
  );
}

function readMarker(binding: ApprovedRoot, rootStat: fs.Stats, anchor?: number): string {
  const descriptor = anchor ?? fs.openSync(
    path.join(binding.root, IDENTITY_MARKER),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.dev !== BigInt(rootStat.dev) ||
      stat.size > 1024n ||
      stat.uid !== BigInt(rootStat.uid) ||
      (stat.mode & 0o022n) !== 0n
    )
      throw new Error("Unsafe identity marker");
    // Bounded read even if a concurrent writer grows the file after fstat.
    const buffer = Buffer.alloc(1025);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (
      bytes > 1024 ||
      buffer.subarray(0, bytes).toString("utf8") !== markerContents(binding)
    )
      throw new Error("Wrong identity marker");
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}`;
  } finally {
    if (anchor === undefined) fs.closeSync(descriptor);
  }
}

/** Operator-only enrollment. No mkdir, no overwrite, no server-side auto-enrollment. */
export function bootstrapLegacyMarker(root: string): void {
  validateRoot(root);
  if ((process.getuid?.() === 0 || process.geteuid?.() === 0)) throw new Error("Privileged enrollment refused");
  const binding = legacyBinding(root, true);
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Untrusted bootstrap root");
  if (process.platform !== "linux")
    throw new Error("Linux mount qualification required");
  const mount = linuxMountIdentity(
    root,
    fs.readFileSync("/proc/self/mountinfo", "utf8"),
  );
  if (!mount || mount.readOnly)
    throw new Error("Writable exact mount required");
  const descriptor = fs.openSync(
    path.join(root, IDENTITY_MARKER),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, markerContents(binding));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directory = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export function legacyBinding(root: string, production = false): ApprovedRoot {
  return {
    id: LEGACY_STORAGE_ID,
    machineKey: LEGACY_STORAGE_KEY,
    mountKey: LEGACY_STORAGE_KEY,
    root,
    writable: true,
    profile: "trusted-legacy",
    requireMount: production,
    requireMarker: production,
  };
}

/** Bindings originate exclusively from the operator, never persisted/API paths.
 * Pins detect observable replacement within this process, not hostile mount races. */
export class StorageMountRegistry {
  private readonly bindings = new Map<string, ApprovedRoot>();
  private readonly pins = new Map<string, string>();
  private readonly markerAnchors = new Map<string, number>();
  private closed = false;
  constructor(bindings: readonly ApprovedRoot[]) {
    const machineKeys = new Set<string>(),
      mountKeys = new Set<string>(),
      roots = new Set<string>();
    for (const input of bindings) {
      validateRoot(input.root);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          input.id,
        ) ||
        !keyPattern.test(input.machineKey) ||
        input.machineKey.length > 100 ||
        !keyPattern.test(input.mountKey) ||
        input.mountKey.length > 100 ||
        typeof input.writable !== "boolean" ||
        typeof input.requireMarker !== "boolean" ||
        typeof input.requireMount !== "boolean" ||
        this.bindings.has(input.id) ||
        machineKeys.has(input.machineKey) ||
        mountKeys.has(input.mountKey) ||
        roots.has(input.root) ||
        !["trusted-legacy", "blocked"].includes(input.profile) ||
        (input.profile === "trusted-legacy" &&
          (input.id !== LEGACY_STORAGE_ID ||
            input.machineKey !== LEGACY_STORAGE_KEY ||
            input.mountKey !== LEGACY_STORAGE_KEY))
      )
        throw new Error("Invalid or duplicate approved storage binding");
      if (
        input.profile === "blocked" &&
        (!input.requireMount || !input.requireMarker)
      )
        throw new Error("Unqualified storage binding");
      this.bindings.set(input.id, Object.freeze({ ...input }));
      machineKeys.add(input.machineKey);
      mountKeys.add(input.mountKey);
      roots.add(input.root);
    }
  }
  approved(id: string, machineKey?: string, mountKey?: string): ApprovedRoot {
    if (this.closed) throw new Error("Storage registry closed");
    const binding = this.bindings.get(id);
    if (
      !binding ||
      (machineKey !== undefined && machineKey !== binding.machineKey) ||
      (mountKey !== undefined && mountKey !== binding.mountKey)
    )
      throw new Error("Unapproved storage identity");
    return binding;
  }
  inspect(id: string, writeProbe = false): StorageDiagnostic {
    const binding = this.approved(id);
    const result = (
      state: StorageState,
      reason: string,
      read = false,
      write = false,
    ): StorageDiagnostic => ({
      id,
      state,
      reason,
      capabilities: { logicalResolution: true, secureOpen: false, read, write },
    });
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(binding.root);
    } catch (e) {
      return result(
        (e as { code?: string }).code === "ENOENT" ? "offline" : "degraded",
        "root-unavailable",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return result("identity-mismatch", "invalid-root");
    let mount: MountIdentity | undefined, fingerprint: string;
    try {
      if (binding.requireMount) {
        if ((process.getuid?.() === 0 || process.geteuid?.() === 0)) return result("degraded", "privileged-runtime-refused");
        if (process.platform !== "linux")
          return result("degraded", "mount-adapter-unavailable");
        mount = linuxMountIdentity(
          binding.root,
          fs.readFileSync("/proc/self/mountinfo", "utf8"),
        );
        if (!mount) return result("offline", "exact-mount-absent-ambiguous-or-nested");
      }
      const marker = binding.requireMarker
        ? readMarker(binding, stat)
        : "trusted-portable";
      const statfs = fs.statfsSync(binding.root);
      fingerprint = JSON.stringify([
        stat.dev,
        stat.ino,
        fs.realpathSync(binding.root),
        statfs.type,
        mount?.fingerprint,
        marker,
      ]);
    } catch {
      return result(
        binding.requireMarker ? "identity-mismatch" : "degraded",
        "identity-unverifiable",
      );
    }
    const pinned = this.pins.get(id);
    if (pinned && pinned !== fingerprint)
      return result("identity-mismatch", "identity-changed");
    if (!pinned) {
      // Retain the original marker inode. Kernel coarse timestamps + immediate inode
      // reuse made stat-only replacement detection unreliable in real Linux tests.
      if (binding.requireMarker) {
        let anchor: number | undefined;
        try {
          anchor = fs.openSync(path.join(binding.root, IDENTITY_MARKER), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const currentMarker = readMarker(binding, stat, anchor);
          const currentFingerprint = JSON.stringify([stat.dev, stat.ino, fs.realpathSync(binding.root), fs.statfsSync(binding.root).type, mount?.fingerprint, currentMarker]);
          if (currentFingerprint !== fingerprint) throw new Error("Marker changed during enrollment");
          this.markerAnchors.set(id, anchor);
        } catch {
          if (anchor !== undefined) fs.closeSync(anchor);
          return result("identity-mismatch", "marker-anchor-unavailable");
        }
      }
      this.pins.set(id, fingerprint);
    }
    if ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())
      return result("degraded", "untrusted-directory");
    try {
      fs.accessSync(binding.root, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      return result("degraded", "read-access-denied");
    }
    if (!binding.writable || mount?.readOnly)
      return result(
        "read-only",
        "write-disabled",
        binding.profile === "trusted-legacy",
      );
    if (binding.profile === "blocked")
      return result("degraded", "secure-open-unavailable");
    try {
      fs.accessSync(binding.root, fs.constants.W_OK);
    } catch {
      return result("read-only", "write-access-denied", true);
    }
    if (writeProbe) {
      const probe = path.join(binding.root, ".hc-probe-" + randomUUID());
      let descriptor: number | undefined;
      let failure: StorageDiagnostic | undefined;
      try {
        descriptor = fs.openSync(
          probe,
          fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        fs.writeSync(descriptor, "homecloud-probe");
        fs.fsyncSync(descriptor);
        const buffer = Buffer.alloc(15);
        if (
          fs.readSync(descriptor, buffer, 0, 15, 0) !== 15 ||
          buffer.toString() !== "homecloud-probe"
        )
          throw new Error("Write probe mismatch");
        // Recheck before touching a pathname again; on replacement leave artifact on old volume.
        const fresh = this.inspect(id);
        if (!fresh.capabilities.write) failure = fresh;
      } catch (e) {
        failure = result(
          ["EACCES", "EROFS", "EPERM"].includes(
            (e as { code?: string }).code || "",
          )
            ? "read-only"
            : "degraded",
          "write-probe-failed",
          true,
        );
      } finally {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
            if (this.inspect(id).capabilities.write) fs.unlinkSync(probe);
          } catch {
            failure = result("degraded", "probe-cleanup-failed", true);
          }
        }
      }
      if (failure) return failure;
    }
    return result("online", "trusted-legacy", true, true);
  }
  assertAccess(id: string, write = false): ApprovedRoot {
    const binding = this.approved(id);
    const diagnostic = this.inspect(id);
    if (write ? !diagnostic.capabilities.write : !diagnostic.capabilities.read)
      throw new Error(
        `Storage unavailable: ${diagnostic.state}/${diagnostic.reason}`,
      );
    return binding;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const descriptor of this.markerAnchors.values()) fs.closeSync(descriptor);
    this.markerAnchors.clear();
  }
  /** Never substitute realpath for race-free descriptor confinement. */
  openSecure(id: string): never {
    this.approved(id);
    throw new Error("Secure descriptor opening unavailable; location blocked");
  }
}
