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
import { SharedChildrenQueryDto } from "./dtos/public-share.dto";

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

    const now = new Date();
    const LOCK_THRESHOLD = 5;

    // Active lock: reject before any password check.
    if (share.lockedUntil && share.lockedUntil.getTime() > now.getTime()) {
      throw new ForbiddenException("Too many password attempts");
    }

    // Atomic: increment only if no active lock; set lock at threshold in same statement.
    // PostgreSQL row-level lock during UPDATE serializes concurrent failures → no lost increments.
    // UPDATE ... RETURNING provides post-update state without a separate SELECT.
    const result = await this.shareLinkRepository
      .createQueryBuilder("share")
      .update()
      .set({
        failedAttempts: () =>
          `CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= NOW()
            THEN 1
            ELSE "failedAttempts" + 1 END`,
        lockedUntil: () =>
          `CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= NOW()
            THEN NULL
            WHEN "failedAttempts" + 1 >= ${LOCK_THRESHOLD}
            THEN NOW() + INTERVAL '15 minutes'
            ELSE "lockedUntil" END`,
      })
      .where(`"id" = :id`, { id: share.id })
      .andWhere(`"lockedUntil" IS NULL OR "lockedUntil" <= NOW()`)
      .returning(["failedAttempts", "lockedUntil"])
      .execute();

    const updatedShare = result?.raw?.[0] as { failedAttempts: number; lockedUntil: Date | null } | undefined;
    if (!updatedShare || updatedShare.failedAttempts >= LOCK_THRESHOLD) {
      throw new ForbiddenException("Too many password attempts");
    }

    const isValid = await bcrypt.compare(password, share.password);

    if (isValid) {
      // Reset only if state was non-zero.
      if (share.failedAttempts > 0 || share.lockedUntil) {
        await this.shareLinkRepository.update(share.id, {
          failedAttempts: 0,
          lockedUntil: null,
        });
      }
      return true;
    }

    throw new ForbiddenException("Invalid password");
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

  private async verifyPublicPassword(
    share: ShareLinkEntity,
    token: string,
    password?: string,
  ): Promise<void> {
    if (!share.password) return;
    if (!password || password.length > 1024) {
      throw new BadRequestException("Password is required or invalid");
    }
    await this.verifySharePassword(token, password);
  }

  private folderSubtreeSql(): string {
    return `
      WITH RECURSIVE ancestors AS (
        SELECT id, "parentId", "userId", "isDeleted"
        FROM folders WHERE id = $1
        UNION
        SELECT parent.id, parent."parentId", parent."userId", parent."isDeleted"
        FROM folders parent
        JOIN ancestors child ON parent.id = child."parentId"
      ), valid_root AS (
        SELECT $1::integer AS id
        WHERE EXISTS (SELECT 1 FROM ancestors WHERE id = $1)
          AND EXISTS (SELECT 1 FROM ancestors WHERE "parentId" IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM ancestors ancestor
            LEFT JOIN files mirror ON mirror."folderId" = ancestor.id
              AND mirror."userId" = $2 AND mirror."isFolder" = true
              AND mirror."isDeleted" = false
            WHERE ancestor."userId" <> $2 OR ancestor."isDeleted" = true
              OR mirror.id IS NULL
          )
      ), subtree AS (
        SELECT f.id
        FROM folders f
        JOIN valid_root root ON root.id = f.id
        JOIN files mirror ON mirror."folderId" = f.id
          AND mirror."userId" = $2 AND mirror."isFolder" = true
          AND mirror."isDeleted" = false
        WHERE f.id = $1 AND f."userId" = $2 AND f."isDeleted" = false
        UNION
        SELECT child.id
        FROM folders child
        JOIN subtree parent ON child."parentId" = parent.id
        JOIN files mirror ON mirror."folderId" = child.id
          AND mirror."userId" = $2 AND mirror."isFolder" = true
          AND mirror."isDeleted" = false
        WHERE child."userId" = $2 AND child."isDeleted" = false
      )`;
  }

  async listSharedChildren(
    token: string,
    query: SharedChildrenQueryDto,
    password?: string,
  ) {
    const share = await this.findShareByToken(token);
    await this.verifyPublicPassword(share, token, password);
    if (!share.file.isFolder || !share.file.folderId) {
      throw new BadRequestException("Share link does not reference a folder");
    }

    const parentId = query.parentId ?? share.file.folderId;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const rows = await this.fileRepository.query(
      `${this.folderSubtreeSql()}, live_share AS (
        SELECT 1 FROM share_links share
        JOIN users owner ON owner.id = share."userId" AND owner."isActive" = true
        JOIN files root_mirror ON root_mirror.id = share."fileId"
          AND root_mirror."folderId" = $1 AND root_mirror."userId" = $2
          AND root_mirror."isFolder" = true AND root_mirror."isDeleted" = false
        WHERE share.token = $6 AND share."userId" = $2 AND share."isActive" = true
          AND (share."expiresAt" IS NULL OR share."expiresAt" > NOW())
      ), allowed_parent AS (
        SELECT id FROM subtree WHERE id = $3 AND EXISTS (SELECT 1 FROM live_share)
      ), children AS (
        SELECT folder.id, folder.name, 'folder'::text AS kind,
          NULL::bigint AS size, NULL::varchar AS "mimeType", folder."createdAt"
        FROM folders folder
        JOIN allowed_parent parent ON folder."parentId" = parent.id
        JOIN files mirror ON mirror."folderId" = folder.id
          AND mirror."userId" = $2 AND mirror."isFolder" = true
          AND mirror."isDeleted" = false
        WHERE folder."userId" = $2 AND folder."isDeleted" = false
        UNION ALL
        SELECT file.id, file.name, 'file'::text AS kind,
          file.size, file."mimeType", file."createdAt"
        FROM files file
        JOIN allowed_parent parent ON file."parentId" = parent.id
        WHERE file."userId" = $2 AND file."isDeleted" = false
          AND file."isFolder" = false
      )
      SELECT child.*, parent.id AS "__parentAllowed"
      FROM allowed_parent parent
      LEFT JOIN LATERAL (
        SELECT * FROM children
        ORDER BY kind DESC, name ASC, id ASC
        LIMIT $4 OFFSET $5
      ) child ON true`,
      [share.file.folderId, share.userId, parentId, limit + 1, offset, token],
    );
    if (!rows.length) {
      throw new NotFoundException("Shared folder not found");
    }
    const items = rows
      .filter((row: { id: number | null }) => row.id !== null)
      .map((row: Record<string, unknown>) => {
        const item = { ...row };
        delete item.__parentAllowed;
        return item;
      });

    return {
      parentId,
      items: items.slice(0, limit),
      limit,
      offset,
      hasMore: items.length > limit,
    };
  }

  async resolveSharedFolderFile(share: ShareLinkEntity, fileId: number): Promise<FileEntity> {
    if (!share.file.isFolder || !share.file.folderId) {
      throw new NotFoundException("Shared file not found");
    }
    const file = await this.fileRepository.findOne({
      where: { id: fileId, userId: share.userId, isDeleted: false, isFolder: false },
    });
    if (!file) throw new NotFoundException("Shared file not found");
    const allowed = await this.fileRepository.query(
      `${this.folderSubtreeSql()}
       SELECT 1 FROM files file
       JOIN subtree parent ON file."parentId" = parent.id
       WHERE file.id = $3 AND file."userId" = $2
         AND file."isDeleted" = false AND file."isFolder" = false
       LIMIT 1`,
      [share.file.folderId, share.userId, fileId],
    );
    if (allowed.length !== 1) throw new NotFoundException("Shared file not found");
    return file;
  }

  async incrementFolderDownloadCount(token: string, fileId: number): Promise<{ downloadCount: number }> {
    const rows = await this.shareLinkRepository.query(
      `WITH RECURSIVE share_context AS (
        SELECT share."userId", root_mirror."folderId" AS "rootId"
        FROM share_links share
        JOIN files root_mirror ON root_mirror.id = share."fileId"
          AND root_mirror."folderId" IS NOT NULL
          AND root_mirror."userId" = share."userId"
          AND root_mirror."isFolder" = true AND root_mirror."isDeleted" = false
        JOIN users owner ON owner.id = share."userId" AND owner."isActive" = true
        WHERE share.token = $1 AND share."isActive" = true
          AND (share."expiresAt" IS NULL OR share."expiresAt" > NOW())
      ), ancestors AS (
        SELECT folder.id, folder."parentId", folder."userId", folder."isDeleted"
        FROM folders folder
        JOIN share_context context ON context."rootId" = folder.id
        UNION
        SELECT parent.id, parent."parentId", parent."userId", parent."isDeleted"
        FROM folders parent
        JOIN ancestors child ON parent.id = child."parentId"
      ), valid_root AS (
        SELECT context."rootId", context."userId"
        FROM share_context context
        WHERE EXISTS (SELECT 1 FROM ancestors WHERE id = context."rootId")
          AND EXISTS (SELECT 1 FROM ancestors WHERE "parentId" IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM ancestors ancestor
            LEFT JOIN files mirror ON mirror."folderId" = ancestor.id
              AND mirror."userId" = context."userId" AND mirror."isFolder" = true
              AND mirror."isDeleted" = false
            WHERE ancestor."userId" <> context."userId" OR ancestor."isDeleted" = true
              OR mirror.id IS NULL
          )
      ), subtree AS (
        SELECT root."rootId" AS id FROM valid_root root
        UNION
        SELECT child.id FROM folders child
        JOIN subtree parent ON child."parentId" = parent.id
        JOIN valid_root root ON true
        JOIN files mirror ON mirror."folderId" = child.id
          AND mirror."userId" = root."userId" AND mirror."isFolder" = true
          AND mirror."isDeleted" = false
        WHERE child."userId" = root."userId" AND child."isDeleted" = false
      ), allowed AS (
        SELECT 1 FROM files file
        JOIN subtree parent ON file."parentId" = parent.id
        JOIN share_links share ON share.token = $1
        WHERE file.id = $2 AND file."userId" = share."userId"
          AND file."isDeleted" = false AND file."isFolder" = false
      )
      UPDATE share_links
      SET "downloadCount" = "downloadCount" + 1, "updatedAt" = NOW()
      WHERE token = $1 AND "isActive" = true
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        AND ("maxDownloads" IS NULL OR "downloadCount" < "maxDownloads")
        AND EXISTS (SELECT 1 FROM allowed)
      RETURNING "downloadCount"`,
      [token, fileId],
    );
    const returnedRows = Array.isArray(rows[0]) ? rows[0] : rows;
    if (!returnedRows.length) {
      throw new NotFoundException("Share link not found or expired");
    }
    return returnedRows[0] as { downloadCount: number };
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
