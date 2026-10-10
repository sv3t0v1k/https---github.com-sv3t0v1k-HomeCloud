import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

interface NativeBoundary {
  root(path: string): object;
  open(root: object, key: string, mode: "r" | "rw" | "wx"): number;
  directory(root: object, key: string): number;
  mkdir(root: object, key: string): void;
  rename(root: object, source: string, destination: string): void;
  remove(root: object, key: string, recursive: boolean): void;
  list(root: object, key: string): string[];
  close(root: object): void;
}
const loadNative = createRequire(__filename);
let binding: NativeBoundary | undefined;
function native(): NativeBoundary {
  if (process.platform !== "linux")
    throw new Error("Secure upload filesystem requires Linux");
  // App-owned build artifact; no search in storage, env or working directory.
  return (binding ??= loadNative(
    path.join(__dirname, "../../native/secure-fs.node"),
  ) as NativeBoundary);
}

/** Paths are labels only. Every lookup/mutation is relative to a module-owned FD. */
export class SecureFilesystem {
  private readonly capability: object;
  private closed = false;
  constructor(
    readonly root: string,
    expected: fs.Stats,
  ) {
    this.capability = native().root(root);
    let fd: number | undefined;
    try {
      fd = native().directory(this.capability, ".");
      const actual = fs.fstatSync(fd);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino)
        throw new Error("Upload root changed during descriptor acquisition");
    } catch (error) {
      native().close(this.capability);
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  private key(absolute: string): string {
    if (this.closed) throw new Error("Secure upload filesystem closed");
    if (
      typeof absolute !== "string" ||
      absolute.includes("\0") ||
      absolute !== path.resolve(absolute)
    )
      throw new Error("Invalid upload path");
    const key = path.relative(this.root, absolute);
    if (key === "") return ".";
    if (key.startsWith("../") || key === ".." || path.isAbsolute(key))
      throw new Error("Upload path escapes root");
    return key;
  }
  open(absolute: string, mode: "r" | "rw" | "wx" = "r"): number {
    return native().open(this.capability, this.key(absolute), mode);
  }
  stat(absolute: string, directory = false): fs.Stats {
    const fd = directory
      ? native().directory(this.capability, this.key(absolute))
      : this.open(absolute);
    try {
      return fs.fstatSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  readStream(absolute: string, maximumBytes?: number): fs.ReadStream {
    if (
      maximumBytes !== undefined &&
      (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    )
      throw new Error("Invalid chunk read limit");
    const fd = this.open(absolute);
    try {
      return fs.createReadStream("", {
        fd,
        autoClose: true,
        ...(maximumBytes === undefined ? {} : { end: maximumBytes - 1 }),
      });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  writeStream(absolute: string): fs.WriteStream {
    const fd = this.open(absolute, "wx");
    try {
      return fs.createWriteStream("", { fd, autoClose: true });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  write(absolute: string, bytes: Buffer): void {
    const fd = this.open(absolute, "wx");
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  sync(absolute: string, directory = false): void {
    const fd = directory
      ? native().directory(this.capability, this.key(absolute))
      : this.open(absolute, "rw");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  mkdir(absolute: string): void {
    native().mkdir(this.capability, this.key(absolute));
  }
  rename(source: string, destination: string): void {
    native().rename(this.capability, this.key(source), this.key(destination));
  }
  remove(absolute: string, recursive = false): void {
    try {
      native().remove(this.capability, this.key(absolute), recursive);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  list(absolute: string): string[] {
    return native().list(this.capability, this.key(absolute));
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      native().close(this.capability);
    }
  }
}
