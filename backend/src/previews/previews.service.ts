import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as sharp from 'sharp';
import { readFileSync } from 'fs';
import { FileEntity } from '../entities/file.entity';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class PreviewsService {
  private readonly logger = new Logger(PreviewsService.name);
  private readonly thumbnailSize = 300;

  constructor(
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    private storageService: StorageService,
  ) {}

  async getThumbnail(userId: number, fileId: number): Promise<Buffer> {
    const file = await this.fileRepository.findOne({ where: { id: fileId, userId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (!file.storagePath || !this.storageService.fileExists(file.storagePath)) {
      throw new NotFoundException('File not found on storage');
    }

    const mimeType = file.mimeType || '';
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('File is not an image');
    }

    try {
      const buffer = readFileSync(file.storagePath);
      const thumbnail = await sharp(buffer)
        .resize(this.thumbnailSize, this.thumbnailSize)
        .png()
        .toBuffer();

      return thumbnail;
    } catch (error) {
      this.logger.error(`Failed to generate thumbnail for file ${fileId}`, error);
      throw new BadRequestException('Failed to generate thumbnail');
    }
  }

  async getPreview(userId: number, fileId: number): Promise<{ type: string; content: string | Buffer; mimeType: string }> {
    const file = await this.fileRepository.findOne({ where: { id: fileId, userId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (!file.storagePath || !this.storageService.fileExists(file.storagePath)) {
      throw new NotFoundException('File not found on storage');
    }

    const mimeType = file.mimeType || '';

    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/javascript' ||
      mimeType === 'application/xml'
    ) {
      const content = readFileSync(file.storagePath, 'utf-8');
      const maxLength = 5000;
      const truncated = content.length > maxLength ? content.slice(0, maxLength) : content;
      return { type: 'text', content: truncated, mimeType };
    }

    if (mimeType.startsWith('image/')) {
      const buffer = readFileSync(file.storagePath);
      return { type: 'image', content: buffer, mimeType };
    }

    return { type: 'unsupported', content: 'Preview not available for this file type.', mimeType: 'text/plain' };
  }

  async getFileInfo(userId: number, fileId: number): Promise<FileEntity> {
    const file = await this.fileRepository.findOne({ where: { id: fileId, userId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return file;
  }
}
