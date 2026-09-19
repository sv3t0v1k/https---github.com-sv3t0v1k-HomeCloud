import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { ConfigService } from "@nestjs/config";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";

@Injectable()
export class SharingService {
  private readonly logger = new Logger(SharingService.name);
  private readonly maxShareSize: number;
  private readonly allowedShareMimeTypes: string[];

  constructor(
    @InjectRepository(ShareLinkEntity)
    private shareLinkRepository: Repository<ShareLinkEntity>,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private configService: ConfigService,
  ) {
    const rawMaxSize = configService.get("MAX_SHARE_SIZE");
    this.maxShareSize = rawMaxSize ? Number(rawMaxSize) : 100 * 1024 * 1024;

    const rawAllowedTypes = configService.get("ALLOWED_SHARE_MIME_TYPES");
    this.allowedShareMimeTypes = rawAllowedTypes
      ? rawAllowedTypes.split(",").map((type: string) => type.trim())
      : [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "application/pdf",
          "text/plain",
          "application/json",
          "application/zip",
        ];
  }

  async createShareLink(
    userId: number,
    fileId: number,
    options: {
      password?: string;
      expiresInDays?: number;
      maxDownloads?: number | null; // null/undefined = unlimited
      isFolder?: boolean;
    },
  ) {
    const file = await this.fileRepository.findOne({
      where: { id: fileId, userId },
    });
    if (!file || file.isDeleted !== false || file.userId !== userId) {
      throw new NotFoundException("File not found");
    }

    if (file.isFolder && options.isFolder === false) {
      throw new BadRequestException("Cannot share folder as file");
    }

    if (!file.isFolder && options.isFolder === true) {
      throw new BadRequestException("Cannot share file as folder");
    }

    if (!file.isFolder && file.size > this.maxShareSize) {
      throw new BadRequestException("File exceeds maximum shareable size");
    }

    if (!file.isFolder && !this.allowedShareMimeTypes.includes(file.mimeType)) {
      throw new BadRequestException("File type is not allowed for sharing");
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || !user.isActive || user.id !== userId) {
      throw new NotFoundException("User not found");
    }

    const token = uuidv4();
    const expiresInDays = options.expiresInDays ?? 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    let passwordHash: string | undefined;
    if (options.password) {
      passwordHash = await bcrypt.hash(options.password, 10);
    }

    const shareLink = this.shareLinkRepository.create({
      token,
      password: passwordHash,
      expiresAt,
      isFolder: options.isFolder ?? file.isFolder,
      isActive: true,
      downloadCount: 0,
      maxDownloads: options.maxDownloads ?? null,
      fileId,
      userId,
      user,
      file,
    });

    await this.shareLinkRepository.save(shareLink);

    return shareLink;
  }

  async findShareByToken(token: string) {
    const share = await this.shareLinkRepository.findOne({
      where: { token, isActive: true },
      relations: ["file", "user"],
    });

    if (
      !share ||
      !share.isActive ||
      (share.expiresAt && share.expiresAt.getTime() <= Date.now()) ||
      !share.file ||
      share.file.isDeleted !== false ||
      share.file.id !== share.fileId ||
      share.file.userId !== share.userId ||
      !share.user ||
      !share.user.isActive ||
      share.user.id !== share.userId
    ) {
      throw new NotFoundException("Share link not found or expired");
    }

    return share;
  }

  async verifySharePassword(token: string, password: string) {
    const share = await this.findShareByToken(token);

    if (!share.password) {
      throw new ForbiddenException("Password not required for this share link");
    }

    const isValid = await bcrypt.compare(password, share.password);
    if (!isValid) {
      throw new ForbiddenException("Invalid password");
    }

    return true;
  }

  /**
   * Atomically check the download policy and increment the counter.
   *
   * A single `UPDATE ... RETURNING` enforces, under the row's lock, all of:
   *  - link active
   *  - not expired (`expiresAt` NULL = never expires)
   *  - download limit not yet reached (`maxDownloads` NULL = unlimited)
   *
   * Exactly one row is returned when the download is allowed (counter advanced
   * by 1); zero rows when it must be rejected (not found / revoked / expired /
   * limit exhausted). Because the check and the increment run in one statement,
   * concurrent downloaders can never push `downloadCount` past `maxDownloads`,
   * and repeated HTTP Range requests on the same link each consume the single
   * shared counter (no bypass via Range/resume).
   */
  async incrementDownloadCount(token: string): Promise<{
    downloadCount: number;
  }> {
    const result = await this.shareLinkRepository
      .createQueryBuilder("share")
      .update()
      .set({
        downloadCount: () => `"downloadCount" + 1`,
        updatedAt: () => `NOW()`,
      })
      .where(
        `"token" = :token AND "isActive" = true AND ("expiresAt" IS NULL OR "expiresAt" > NOW())`,
        { token },
      )
      .andWhere(`("maxDownloads" IS NULL OR "downloadCount" < "maxDownloads")`)
      .returning(["downloadCount"])
      .execute();

    if (!result?.raw?.length) {
      throw new NotFoundException("Share link not found or expired");
    }

    return result.raw[0] as { downloadCount: number };
  }

  async revokeShare(userId: number, shareId: number) {
    const share = await this.shareLinkRepository.findOne({
      where: { id: shareId, userId },
    });

    if (!share) {
      throw new NotFoundException("Share link not found");
    }

    share.isActive = false;
    await this.shareLinkRepository.save(share);

    return { message: "Share link revoked successfully" };
  }

  async listUserShares(userId: number) {
    const shares = await this.shareLinkRepository.find({
      where: { userId, isActive: true },
      relations: ["file"],
      order: { createdAt: "DESC" },
    });

    return shares;
  }

  async getShareById(userId: number, shareId: number) {
    const share = await this.shareLinkRepository.findOne({
      where: { id: shareId, userId },
      relations: ["file"],
    });

    if (!share) {
      throw new NotFoundException("Share link not found");
    }

    return share;
  }
}
