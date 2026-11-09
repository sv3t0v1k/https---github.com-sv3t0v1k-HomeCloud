import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import sharp from "sharp";
import * as fs from "fs";
import { FileEntity } from "../entities/file.entity";
import { assertVisibleAncestors } from "../files/file-visibility";
import { StorageService } from "../storage/storage.service";

@Injectable()
export class PreviewsService {
  private readonly logger = new Logger(PreviewsService.name);
  private readonly thumbnailSize = 300;
  private readonly maxPreviewBytes = 5 * 1024 * 1024;

  private readonly maxThumbnailBytes = 32 * 1024 * 1024;
  private readonly maxThumbnailPixels = 24_000_000;
  private activeThumbnails = 0;
  private readonly thumbnailWaiters: Array<() => void> = [];

  private assertThumbnailActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ServiceUnavailableException("Thumbnail request cancelled");
    }
  }

  private async withThumbnailSlot<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertThumbnailActive(signal);

    if (this.activeThumbnails >= 2) {
      if (this.thumbnailWaiters.length >= 16) {
        throw new ServiceUnavailableException("Thumbnail service is busy");
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        };

        const remove = () => {
          const index = this.thumbnailWaiters.indexOf(wake);
          if (index >= 0) this.thumbnailWaiters.splice(index, 1);
        };

        const wake = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };

        const cancel = () => {
          if (settled) return;
          settled = true;
          remove();
          cleanup();
          reject(
            new ServiceUnavailableException("Thumbnail request cancelled"),
          );
        };

        const expire = () => {
          if (settled) return;
          settled = true;
          remove();
          cleanup();
          reject(
            new ServiceUnavailableException(
              "Thumbnail queue wait timed out",
            ),
          );
        };

        timer = setTimeout(expire, 5_000);
        this.thumbnailWaiters.push(wake);
        signal?.addEventListener("abort", cancel, { once: true });

        if (signal?.aborted) cancel();
      });
    } else {
      this.activeThumbnails += 1;
    }

    try {
      this.assertThumbnailActive(signal);
      const result = await run();
      this.assertThumbnailActive(signal);
      return result;
    } finally {
      // An active operation retains its slot until it actually settles.
      const next = this.thumbnailWaiters.shift();
      if (next) next();
      else this.activeThumbnails -= 1;
    }
  }

  private matchesImageHeader(data: Buffer, mime: string): boolean {
    if (mime === "image/jpeg") {
      return data.length >= 3 &&
        data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    }
    if (mime === "image/png") {
      return data.length >= 8 &&
        data.subarray(0, 8).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
    }
    if (mime === "image/webp") {
      return data.length >= 12 &&
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP";
    }
    return false;
  }

  private async readBoundedImage(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.assertThumbnailActive(signal);
    // Linux openat2: pinned root, no symlinks, no mount escapes.
    // Never fall back to pathname-based fs.promises.open().
    const fd = this.storageService.openReadOnlyFileSecure(filePath);

    try {
      const before = fs.fstatSync(fd);

      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) ||
        before.size <= 0 ||
        before.size > this.maxThumbnailBytes
      ) {
        throw new BadRequestException("Image exceeds thumbnail limits");
      }

      const data = Buffer.allocUnsafe(before.size);
      let offset = 0;

      while (offset < data.length) {
        this.assertThumbnailActive(signal);
        const bytesRead = await new Promise<number>((resolve, reject) => {
          fs.read(
            fd,
            data,
            offset,
            data.length - offset,
            offset,
            (error, count) => {
              if (error) reject(error);
              else resolve(count);
            },
          );
        });

        if (bytesRead <= 0) {
          throw new BadRequestException("Image changed during reading");
        }
        offset += bytesRead;
        this.assertThumbnailActive(signal);
      }

      const after = fs.fstatSync(fd);
      if (
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new BadRequestException("Image changed during reading");
      }

      return data;
    } finally {
      fs.closeSync(fd);
    }
  }

  constructor(
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    private storageService: StorageService,
  ) {}

  private async readAuthorizedThumbnail(
    userId: number,
    fileId: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.assertThumbnailActive(signal);
    return this.fileRepository.manager.transaction(async (manager) => {
      this.assertThumbnailActive(signal);
      // Folder deletion/move obtains FOR UPDATE on the same user.
      // Hold FOR SHARE until the image bytes have been read.
      const owner: Array<{ id: number }> = await manager.query(
        "SELECT id FROM users WHERE id=$1 FOR SHARE",
        [userId],
      );
      this.assertThumbnailActive(signal);
      if (owner.length !== 1) {
        throw new NotFoundException("File not found");
      }

      const file = await manager.findOne(FileEntity, {
        where: { id: fileId, userId, isDeleted: false },
      });
      if (!file || file.isFolder) {
        throw new NotFoundException("File not found");
      }

      await assertVisibleAncestors(
        manager,
        userId,
        file.parentId ?? null,
      );
      this.assertThumbnailActive(signal);

      const mimeType = file.mimeType || "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
        throw new BadRequestException("Image format not supported");
      }

      let filePath: string;
      try {
        filePath = this.storageService.resolveFilePath(file);
      } catch {
        throw new NotFoundException("File not found on storage");
      }

      this.assertThumbnailActive(signal);
      const data = await this.readBoundedImage(filePath, signal);
      this.assertThumbnailActive(signal);
      if (!this.matchesImageHeader(data, mimeType)) {
        throw new BadRequestException("Image format mismatch");
      }
      return data;
    });
  }

  async getThumbnail(
    userId: number,
    fileId: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return this.withThumbnailSlot(async () => {
      try {
        this.assertThumbnailActive(signal);
        const data = await this.readAuthorizedThumbnail(
          userId, fileId, signal,
        );
        this.assertThumbnailActive(signal);

        const result = await sharp(data, {
          limitInputPixels: this.maxThumbnailPixels,
          failOn: "warning",
          sequentialRead: true,
          animated: false,
          pages: 1,
          unlimited: false,
        })
          .rotate()
          .resize(this.thumbnailSize, this.thumbnailSize, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .timeout({ seconds: 10 })
          .toBuffer();

        // Sharp may not stop native processing immediately.
        // Keep its active slot until toBuffer() settles.
        this.assertThumbnailActive(signal);
        if (!result.length || result.length > 2 * 1024 * 1024) {
          throw new BadRequestException("Thumbnail output exceeds limit");
        }

        return result;
      } catch (error) {
        this.assertThumbnailActive(signal);
        if (
          error instanceof NotFoundException ||
          error instanceof ServiceUnavailableException
        ) {
          throw error;
        }
        this.logger.warn("Failed to generate thumbnail for file");
        throw new BadRequestException("Failed to generate thumbnail");
      }
    }, signal);
  }

  private async readSecurePreviewBytes(
    filePath: string,
    isText: boolean,
  ): Promise<{ data: Buffer; truncated: boolean }> {
    // Descriptor-based confinement is mandatory. No pathname fallback.
    let fd: number;
    try {
      fd = this.storageService.openReadOnlyFileSecure(filePath);
    } catch {
      throw new NotFoundException("File not found on storage");
    }

    try {
      const before = fs.fstatSync(fd);

      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) ||
        before.size < 0
      ) {
        throw new BadRequestException("Invalid preview file");
      }

      if (!isText && before.size > this.maxPreviewBytes) {
        throw new BadRequestException(
          "Image exceeds maximum preview size",
        );
      }

      const length = Math.min(before.size, this.maxPreviewBytes);
      const data = Buffer.alloc(length);
      let offset = 0;

      while (offset < length) {
        const bytesRead = await new Promise<number>((resolve, reject) => {
          fs.read(
            fd,
            data,
            offset,
            length - offset,
            offset,
            (error, count) => {
              if (error) reject(error);
              else resolve(count);
            },
          );
        });

        if (bytesRead <= 0) {
          throw new BadRequestException("Preview changed during reading");
        }

        offset += bytesRead;
      }

      const after = fs.fstatSync(fd);
      if (
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new BadRequestException("Preview changed during reading");
      }

      return {
        data,
        truncated: isText && before.size > this.maxPreviewBytes,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  async getPreview(
    userId: number,
    fileId: number,
  ): Promise<{ type: string; content: string | Buffer; mimeType: string }> {
    return this.fileRepository.manager.transaction(async (manager) => {
      // Serialize visibility checks against folder move/delete/restore.
      const owner: Array<{ id: number }> = await manager.query(
        "SELECT id FROM users WHERE id=$1 FOR SHARE",
        [userId],
      );
      if (owner.length !== 1) {
        throw new NotFoundException("File not found");
      }

      const file = await manager.findOne(FileEntity, {
        where: { id: fileId, userId, isDeleted: false },
      });

      if (!file || file.isDeleted || file.isFolder) {
        throw new NotFoundException("File not found");
      }

      await assertVisibleAncestors(
        manager,
        userId,
        file.parentId ?? null,
      );

      let filePath: string;
      try {
        filePath = this.storageService.resolveFilePath(file);
      } catch {
        throw new NotFoundException("File not found on storage");
      }

      const mimeType = file.mimeType || "";
      const isText =
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/javascript" ||
        mimeType === "application/xml";

      const isImage = mimeType.startsWith("image/");

      if (!isText && !isImage) {
        return {
          type: "unsupported",
          content: "Preview not available for this file type.",
          mimeType: "text/plain",
        };
      }

      const { data, truncated } = await this.readSecurePreviewBytes(
        filePath,
        isText,
      );

      if (isText) {
        const suffix = truncated ? "\n... (truncated)" : "";
        return {
          type: "text",
          content: data.toString("utf8") + suffix,
          mimeType,
        };
      }

      return { type: "image", content: data, mimeType };
    });
  }

  async getFileInfo(userId: number, fileId: number): Promise<FileEntity> {
    const file = await this.fileRepository.findOne({
      where: { id: fileId, userId },
    });
    if (!file) {
      throw new NotFoundException("File not found");
    }
    return file;
  }
}
