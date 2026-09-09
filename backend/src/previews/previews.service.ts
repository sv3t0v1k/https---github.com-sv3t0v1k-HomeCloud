import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
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

  constructor(
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    private storageService: StorageService,
  ) {}

  async getThumbnail(userId: number, fileId: number): Promise<Buffer> {
    const file = await this.fileRepository.findOne({
      where: { id: fileId, userId },
    });
    if (!file) {
      throw new NotFoundException("File not found");
    }

    if (
      !file.storagePath ||
      !this.storageService.fileExists(file.storagePath)
    ) {
      throw new NotFoundException("File not found on storage");
    }

    const mimeType = file.mimeType || "";
    if (!mimeType.startsWith("image/")) {
      throw new BadRequestException("File is not an image");
    }

    try {
      const stats = await fs.promises.stat(file.storagePath);
      if (stats.size > this.maxPreviewBytes) {
        throw new BadRequestException("Image exceeds maximum preview size");
      }
      const buffer = fs.readFileSync(file.storagePath);
      const thumbnail = await sharp(buffer)
        .resize(this.thumbnailSize, this.thumbnailSize, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      return thumbnail;
    } catch (error) {
      this.logger.error(
        `Failed to generate thumbnail for file ${fileId}`,
        error,
      );
      throw new BadRequestException("Failed to generate thumbnail");
    }
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

    if (
      !file.storagePath ||
      !this.storageService.fileExists(file.storagePath)
    ) {
      throw new NotFoundException("File not found on storage");
    }

    const mimeType = file.mimeType || "";

    if (
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/javascript" ||
      mimeType === "application/xml"
    ) {
      const stream = fs.createReadStream(file.storagePath, {
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
      const stats = await fs.promises.stat(file.storagePath);
      if (stats.size > this.maxPreviewBytes) {
        throw new BadRequestException("Image exceeds maximum preview size");
      }
      const buffer = fs.readFileSync(file.storagePath);
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
