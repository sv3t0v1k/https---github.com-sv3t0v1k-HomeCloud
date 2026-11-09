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

  private async withThumbnailSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.activeThumbnails >= 2) {
      if (this.thumbnailWaiters.length >= 16) {
        throw new ServiceUnavailableException("Thumbnail service is busy");
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;

        const wake = () => {
          clearTimeout(timer);
          resolve();
        };

        timer = setTimeout(() => {
          const index = this.thumbnailWaiters.indexOf(wake);
          if (index < 0) return;

          this.thumbnailWaiters.splice(index, 1);
          reject(
            new ServiceUnavailableException(
              "Thumbnail queue wait timed out",
            ),
          );
        }, 5_000);

        this.thumbnailWaiters.push(wake);
      });
    } else {
      this.activeThumbnails += 1;
    }

    try {
      return await run();
    } finally {
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

  private async readBoundedImage(filePath: string): Promise<Buffer> {
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

  private async assertVisibleAncestors(
    manager: import("typeorm").EntityManager,
    userId: number,
    parentId: number | null,
  ): Promise<void> {
    if (parentId === null) return;
    if (!Number.isSafeInteger(parentId) || parentId <= 0) {
      throw new NotFoundException("File not found");
    }

    const rows: Array<{ visible: boolean }> = await manager.query(
      `
      WITH RECURSIVE ancestor_chain AS (
        SELECT folder.id, folder."parentId", folder."isDeleted",
               ARRAY[folder.id]::integer[] AS visited,
               FALSE AS cycle
        FROM folders folder
        WHERE folder.id = $2 AND folder."userId" = $1

        UNION ALL

        SELECT parent.id, parent."parentId", parent."isDeleted",
               chain.visited || parent.id,
               parent.id = ANY(chain.visited)
        FROM folders parent
        JOIN ancestor_chain chain ON parent.id = chain."parentId"
        WHERE parent."userId" = $1
          AND NOT chain.cycle
          AND cardinality(chain.visited) < 256
      )
      SELECT (
        COALESCE(bool_and(
          NOT chain."isDeleted"
          AND NOT chain.cycle
          AND EXISTS (
            SELECT 1 FROM files mirror
            WHERE mirror."folderId" = chain.id
              AND mirror."userId" = $1
              AND mirror."isFolder"
              AND NOT mirror."isDeleted"
              AND mirror."parentId"
                  IS NOT DISTINCT FROM chain."parentId"
          )
        ), FALSE)
        AND COALESCE(bool_or(chain."parentId" IS NULL), FALSE)
      ) AS visible
      FROM ancestor_chain chain
      `,
      [userId, parentId],
    );

    if (rows.length !== 1 || rows[0].visible !== true) {
      throw new NotFoundException("File not found");
    }
  }

  private async readAuthorizedThumbnail(
    userId: number,
    fileId: number,
  ): Promise<Buffer> {
    return this.fileRepository.manager.transaction(async (manager) => {
      // Folder deletion/move obtains FOR UPDATE on the same user.
      // Hold FOR SHARE until the image bytes have been read.
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
      if (!file || file.isFolder) {
        throw new NotFoundException("File not found");
      }

      await this.assertVisibleAncestors(
        manager,
        userId,
        file.parentId ?? null,
      );

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

      const data = await this.readBoundedImage(filePath);
      if (!this.matchesImageHeader(data, mimeType)) {
        throw new BadRequestException("Image format mismatch");
      }
      return data;
    });
  }

  async getThumbnail(userId: number, fileId: number): Promise<Buffer> {
    return this.withThumbnailSlot(async () => {
      try {
        const data = await this.readAuthorizedThumbnail(userId, fileId);

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

        if (!result.length || result.length > 2 * 1024 * 1024) {
          throw new BadRequestException("Thumbnail output exceeds limit");
        }

        return result;
      } catch (error) {
        if (
          error instanceof NotFoundException ||
          error instanceof ServiceUnavailableException
        ) {
          throw error;
        }
        this.logger.warn("Failed to generate thumbnail for file");
        throw new BadRequestException("Failed to generate thumbnail");
      }
    });
  }

  async getPreview(
    userId: number,
    fileId: number,
  ): Promise<{ type: string; content: string | Buffer; mimeType: string }> {
    const file = await this.fileRepository.findOne({
      where: { id: fileId, userId },
    });
    if (!file) {
      throw new NotFoundException("File not found");
    }

    let filePath: string;
    try { filePath = this.storageService.resolveFilePath(file); }
    catch { throw new NotFoundException("File not found on storage"); }

    const mimeType = file.mimeType || "";

    if (
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/javascript" ||
      mimeType === "application/xml"
    ) {
      const stream = fs.createReadStream(filePath, {
        encoding: "utf-8",
      });
      let content = "";
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > this.maxPreviewBytes) {
          content += "\n... (truncated)";
          break;
        }
        content += chunk;
      }
      return { type: "text", content, mimeType };
    }

    if (mimeType.startsWith("image/")) {
      const stats = await fs.promises.stat(filePath);
      if (stats.size > this.maxPreviewBytes) {
        throw new BadRequestException("Image exceeds maximum preview size");
      }
      const buffer = fs.readFileSync(filePath);
      const chunks: Buffer[] = [buffer];
      return { type: "image", content: Buffer.concat(chunks), mimeType };
    }

    return {
      type: "unsupported",
      content: "Preview not available for this file type.",
      mimeType: "text/plain",
    };
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
