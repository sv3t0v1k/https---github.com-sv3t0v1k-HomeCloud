import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Readable } from "stream";

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly storagePath: string;
  private readonly tempPath: string;

  constructor(private configService: ConfigService) {
    this.storagePath = configService.get("STORAGE_PATH") || "/storage";
    this.tempPath = path.join(this.storagePath, ".tmp");
    this.ensureDirectories();
  }

  private ensureDirectories() {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
    if (!fs.existsSync(this.tempPath)) {
      fs.mkdirSync(this.tempPath, { recursive: true });
    }
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  getTempPath(): string {
    return this.tempPath;
  }

  generateSafeFilename(originalName: string): string {
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const unique = crypto.randomBytes(8).toString("hex");
    return `${safeBase}_${unique}${ext.toLowerCase()}`;
  }

  generatePath(userId: number, filename: string): string {
    const userDir = path.join(this.storagePath, String(userId));
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const fullPath = path.join(userDir, filename);
    return this.ensureWithinStorageRoot(fullPath);
  }

  ensureWithinStorageRoot(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(this.storagePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error("Path traversal detected");
    }
    return resolved;
  }

  async writeFile(filePath: string, data: Buffer | Readable): Promise<void> {
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
    return fs.createReadStream(filePath);
  }

  async deleteFile(filePath: string): Promise<void> {
    const safePath = this.ensureWithinStorageRoot(filePath);
    if (fs.existsSync(safePath)) {
      fs.unlinkSync(safePath);
    }
  }

  fileExists(filePath: string): boolean {
    const safePath = this.ensureWithinStorageRoot(filePath);
    return fs.existsSync(safePath);
  }

  getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  getStorageUsage(userId: number): number {
    const userDir = path.join(this.storagePath, String(userId));
    if (!fs.existsSync(userDir)) return 0;
    return this.calculateDirSize(userDir);
  }

  private calculateDirSize(dirPath: string): number {
    let size = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += this.calculateDirSize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
    return size;
  }
}
