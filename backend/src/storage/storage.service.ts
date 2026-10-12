import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Readable } from "stream";
import { ssdUploadBinding } from "./ssd-upload-binding";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { ApprovedRoot, legacyBinding } from "./storage-mount-registry";
import { LEGACY_STORAGE_ID } from "./storage-mount-registry";
import { FilePlacement, StorageRegistry } from "./storage-placement";

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly storagePath: string;
  private readonly tempPath: string;
  private readonly registry: StorageRegistry;
  private readonly ssdBinding: ApprovedRoot | undefined;

  constructor(private configService: ConfigService) {
    this.storagePath = configService.get("STORAGE_PATH") || "/storage";
    this.tempPath = path.join(this.storagePath, ".tmp");
    const production = configService.get("NODE_ENV") === "production";
    this.ssdBinding = ssdUploadBinding(configService, this.storagePath);
    this.registry = new StorageRegistry(this.storagePath, production, [
      legacyBinding(this.storagePath, production),
      ...(this.ssdBinding ? [this.ssdBinding] : []),
    ]);
    try {
      this.ensureDirectories();
    } catch (error) {
      this.registry.close();
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.registry.close();
  }

  private ensureDirectories() {
    const diagnostic = this.registry.mounts.inspect(LEGACY_STORAGE_ID, true);
    if (!diagnostic.capabilities.write)
      throw new Error(
        `Storage unavailable: ${diagnostic.state}/${diagnostic.reason}`,
      );
    this.registry.assertTemporaryPath(this.tempPath);
    const root = fs.lstatSync(this.storagePath);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error("Invalid storage root");
    if (
      fs.existsSync(this.tempPath) &&
      !fs.lstatSync(this.tempPath).isDirectory()
    )
      throw new Error("Invalid temporary directory");
    if (!fs.existsSync(this.tempPath)) {
      if (this.configService.get("NODE_ENV") === "production")
        throw new Error(
          "Upload workspace unavailable: provision legacy .tmp before startup",
        );
      fs.mkdirSync(this.tempPath, { recursive: true });
    }
  }

  placementForPath(absolutePath: string) {
    this.registry.assertLegacyAccess(true);
    return this.registry.placementForPath(absolutePath);
  }

  resolveFilePath(file: FilePlacement, allowMissing = false): string {
    return this.registry.resolve(file, allowMissing);
  }

  getStoragePath(): string {
    this.registry.assertLegacyAccess();
    return this.storagePath;
  }

  getTempPath(): string {
    this.registry.assertTemporaryPath(this.tempPath);
    return this.tempPath;
  }

  /** Stage 1 preparation only. Never used for File placement or normal upload admission. */
  getPreparedSsdRoot(): string {
    if (!this.ssdBinding) throw new Error("Temporary SSD is not configured");
    this.registry.mounts.assertAccess(SSD_UPLOAD_WORKSPACE.id, true);
    // A second directory/bind of the permanent filesystem is not a second volume.
    if (
      fs.lstatSync(this.ssdBinding.root).dev ===
      fs.lstatSync(this.storagePath).dev
    )
      throw new Error("Temporary SSD must use a separate filesystem");
    return this.ssdBinding.root;
  }

  assertPreparedSsdPath(absolute: string): string {
    const root = this.getPreparedSsdRoot();
    if (
      typeof absolute !== "string" ||
      absolute !== path.resolve(absolute) ||
      absolute.includes("\\") ||
      absolute.includes("\0") ||
      !(absolute === root || absolute.startsWith(root + path.sep))
    )
      throw new Error("Unsafe temporary SSD path");
    const rootStat = fs.lstatSync(root);
    const realRoot = fs.realpathSync(root);
    let current = root;
    for (const component of path
      .relative(root, absolute)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, component);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return absolute;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        stat.dev !== rootStat.dev ||
        fs.realpathSync(current) !==
          path.join(realRoot, path.relative(root, current)) ||
        (stat.isDirectory() &&
          ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error("Unsafe temporary SSD object");
    }
    return absolute;
  }

  preparedSsdDiagnostic() {
    return this.ssdBinding
      ? this.registry.mounts.inspect(SSD_UPLOAD_WORKSPACE.id)
      : undefined;
  }

  generateSafeFilename(originalName: string): string {
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const unique = crypto.randomBytes(8).toString("hex");
    return `${safeBase}_${unique}${ext.toLowerCase()}`;
  }

  generatePath(userId: number, filename: string): string {
    this.registry.assertLegacyAccess(true);
    const userDir = path.join(this.storagePath, String(userId));
    this.registry.keyFromAbsolute(path.join(userDir, "probe"), true);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const fullPath = path.join(userDir, filename);
    return this.ensureWithinStorageRoot(fullPath);
  }

  /**
   * Generate a deterministic final path keyed by uploadId.
   * Retries of the same completeUpload reuse this path instead of
   * creating duplicate files (O-09).
   */
  generateFinalPath(
    userId: number,
    uploadId: string,
    filename: string,
  ): string {
    this.registry.assertLegacyAccess(true);
    const userDir = path.join(this.storagePath, String(userId));
    this.registry.keyFromAbsolute(path.join(userDir, "probe"), true);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const diskName = `${safeBase}_${uploadId}${ext.toLowerCase()}`;
    // Logical names live in metadata. A valid 255-character user name can
    // exceed the filesystem's 255-byte component limit after adding the UUID
    // or encoding a Unicode extension. Preserve ordinary paths unchanged.
    const boundedDiskName =
      Buffer.byteLength(diskName, "utf8") > 255
        ? `${uploadId}.upload`
        : diskName;
    const fullPath = path.join(userDir, boundedDiskName);
    return this.ensureWithinStorageRoot(fullPath);
  }

  ensureWithinStorageRoot(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(this.storagePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error("Path traversal detected");
    }
    if (resolved !== targetPath || resolved === root)
      throw new Error("Path traversal detected");
    this.registry.keyFromAbsolute(resolved, true);
    return resolved;
  }

  async writeFile(filePath: string, data: Buffer | Readable): Promise<void> {
    this.assertTrustedPath(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (Buffer.isBuffer(data)) {
      fs.writeFileSync(filePath, data);
    } else {
      return new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(filePath);
        data.pipe(stream);
        stream.on("finish", () => resolve());
        stream.on("error", (err) => reject(err));
      });
    }
  }

  async readFile(filePath: string): Promise<Readable> {
    this.assertTrustedPath(filePath, false);
    this.registry.keyFromAbsolute(filePath);
    return fs.createReadStream(filePath);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    this.registry.assertLegacyAccess(true);
    const safeSourcePath = this.ensureWithinStorageRoot(sourcePath);
    const safeDestinationPath = this.ensureWithinStorageRoot(destinationPath);
    await fs.promises.copyFile(
      safeSourcePath,
      safeDestinationPath,
      fs.constants.COPYFILE_EXCL,
    );
  }

  async deleteFile(filePath: string): Promise<void> {
    this.registry.assertLegacyAccess(true);
    const safePath = this.ensureWithinStorageRoot(filePath);
    try {
      await fs.promises.unlink(safePath);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
  }

  fileExists(filePath: string): boolean {
    const safePath = this.ensureWithinStorageRoot(filePath);
    return fs.existsSync(safePath);
  }

  getFileSize(filePath: string): number {
    this.assertTrustedPath(filePath, false);
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  getStorageUsage(userId: number): number {
    this.registry.assertLegacyAccess();
    const userDir = path.join(this.storagePath, String(userId));
    if (!fs.existsSync(userDir)) return 0;
    this.registry.assertDirectoryPath(userDir);
    return this.calculateDirSize(userDir);
  }

  /** Revalidate legacy admission before existing direct FS operations. Not openat2. */
  assertTrustedPath(absolute: string, write = true, directory = false): string {
    this.registry.assertLegacyAccess(write);
    if (
      absolute === this.tempPath ||
      absolute.startsWith(this.tempPath + path.sep)
    )
      return this.registry.assertTemporaryPath(absolute, write);
    if (directory) return this.registry.assertDirectoryPath(absolute, write);
    return this.ensureWithinStorageRoot(absolute);
  }

  assertTemporaryPath(absolute: string): string {
    return this.registry.assertTemporaryPath(absolute);
  }

  storageDiagnostic(writeProbe = false) {
    return this.registry.mounts.inspect(LEGACY_STORAGE_ID, writeProbe);
  }

  private calculateDirSize(dirPath: string): number {
    let size = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unsafe storage object");
      if (entry.isDirectory()) {
        this.registry.assertDirectoryPath(fullPath);
        size += this.calculateDirSize(fullPath);
      } else {
        this.registry.keyFromAbsolute(fullPath);
        size += fs.lstatSync(fullPath).size;
      }
    }
    return size;
  }
}
