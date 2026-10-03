import { Writable } from "stream";
import * as fs from "fs";
import * as path from "path";
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { ConfigService } from "@nestjs/config";
import archiver from "archiver";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { SharedChildrenQueryDto } from "./dtos/public-share.dto";
import { StorageService } from "../storage/storage.service";

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
    private storageService: StorageService,
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

  /**
   * Returns every live member of a shared folder subtree that would belong to a
   * folder archive, together with its logical archive path.
   *
   * Scope rules are identical to `listSharedChildren` / `resolveSharedFolderFile`:
   *  - root must be a live folder mirror (`folderId` NOT NULL);
   *  - every ancestor must be owned by the same active user and not soft-deleted;
   *  - every folder in the subtree must have a live mirror row;
   *  - soft-deleted files/folders are excluded;
   *  - legacy `folderId = NULL` mirrors fail closed (no backfill).
   *
   * Archive entry names are logical paths only and never contain absolute
   * filesystem paths or `..` traversal (see `safeArchivePath`).
   */
  async listArchiveMembers(
    share: ShareLinkEntity,
  ): Promise<
    Array<{
      folderId: number;
      name: string;
      logicalPath: string;
      isFolder: boolean;
      storagePath: string | null;
      size: number;
    }>
  > {
    if (!share.file.isFolder || !share.file.folderId) {
      throw new BadRequestException("Share link does not reference a folder");
    }

    const rows = await this.fileRepository.query(
      `${this.folderSubtreeSql()}
       SELECT folder.id AS "folderId", folder.name AS "name", true AS "isFolder",
         NULL::varchar AS "storagePath", NULL::bigint AS "size",
         folder."parentId" AS "parentId"
       FROM folders folder
       JOIN subtree parent ON folder."parentId" = parent.id
       JOIN files mirror ON mirror."folderId" = folder.id
         AND mirror."userId" = $2 AND mirror."isFolder" = true AND mirror."isDeleted" = false
       WHERE folder."userId" = $2 AND folder."isDeleted" = false
       UNION ALL
       SELECT folder.id AS "folderId", folder.name AS "name", true AS "isFolder",
         NULL::varchar AS "storagePath", NULL::bigint AS "size",
         folder."parentId" AS "parentId"
       FROM folders folder
       JOIN subtree root ON root.id = $1
       JOIN files mirror ON mirror."folderId" = folder.id
         AND mirror."userId" = $2 AND mirror."isFolder" = true AND mirror."isDeleted" = false
       WHERE folder.id = $1 AND folder."userId" = $2 AND folder."isDeleted" = false
       UNION ALL
       SELECT file.id AS "folderId", file.name AS "name", false AS "isFolder",
         file."storagePath", file."size",
         file."parentId" AS "parentId"
       FROM files file
       JOIN subtree parent ON file."parentId" = parent.id
       WHERE file."userId" = $2 AND file."isDeleted" = false AND file."isFolder" = false`,
      [share.file.folderId, share.userId],
    );

    const folderRows = rows.filter((r: any) => r.isFolder);
    const folderPathMap = new Map<number, string>();
    folderPathMap.set(share.file.folderId, "");

    const orderedFolders = folderRows.sort(
      (a: any, b: any) => {
        const depthA = a.parentId ? (folderPathMap.get(a.parentId) ?? "") : "";
        const depthB = b.parentId ? (folderPathMap.get(b.parentId) ?? "") : "";
        return depthA.length - depthB.length;
      },
    );
    for (const row of orderedFolders) {
      if (row.folderId === share.file.folderId) continue;
      const parentPath = row.parentId ? folderPathMap.get(row.parentId) ?? "" : "";
      folderPathMap.set(row.folderId, parentPath ? `${parentPath}/${row.name}` : row.name);
    }

    return rows.map((row: any) => {
      const parentPath = row.parentId ? folderPathMap.get(row.parentId) ?? "" : "";
      const logicalPath = row.isFolder
        ? folderPathMap.get(row.folderId) ?? row.name
        : parentPath
          ? `${parentPath}/${row.name}`
          : row.name;
      return {
        folderId: row.folderId,
        name: row.name,
        logicalPath,
        isFolder: row.isFolder,
        storagePath: row.storagePath as string | null,
        size: Number(row.size ?? 0),
      };
    });
  }

  /**
   * Build a logical archive entry name from a relative path.
   * Rejects absolute paths, `..` segments and platform-specific escape
   * sequences. The result is used only as a ZIP entry name — it never maps a
   * storage filesystem path.
   */
  static safeArchivePath(relativePath: string): string {
    if (!relativePath) return "";
    if (path.isAbsolute(relativePath)) {
      throw new BadRequestException("Invalid archive path");
    }
    const normalized = relativePath.replace(/\\/g, "/").split("/");
    const parts: string[] = [];
    for (const part of normalized) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        throw new BadRequestException("Invalid archive path");
      }
      parts.push(part);
    }
    if (parts.length === 0) {
      throw new BadRequestException("Invalid archive path");
    }
    return parts.join("/");
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

  /**
   * Atomic admission for a whole-folder ZIP archive request.
   *
   * Semantics match `incrementFolderDownloadCount` but the scope predicate is
   * the shared folder root itself (not a specific descendant file): one ZIP
   * request consumes exactly ONE slot, regardless of how many members the
   * archive contains. The slot is final — it is never returned on archive,
   * stream or client-abort failure.
   */
  async incrementFolderArchiveDownloadCount(
    token: string,
  ): Promise<{ downloadCount: number }> {
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
      ), allowed AS (
        SELECT 1 FROM valid_root
      )
      UPDATE share_links
      SET "downloadCount" = "downloadCount" + 1, "updatedAt" = NOW()
      WHERE token = $1 AND "isActive" = true
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        AND ("maxDownloads" IS NULL OR "downloadCount" < "maxDownloads")
        AND EXISTS (SELECT 1 FROM allowed)
      RETURNING "downloadCount"`,
      [token],
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

  /**
   * Stream a ZIP archive of every live member inside a shared folder subtree.
   *
   * Memory model: bounded. Member file contents are never read into memory as a
   * whole — each member is opened with the same symlink-safe, storage-root
   * confined pattern used by `downloadShare` (`storageService.ensureWithinStorageRoot`
   * → `realpathSync` → `openSync(O_RDONLY | O_NOFOLLOW)` → `fstat` isFile) and
   * piped into the archive through `archiver`. Only metadata and entry names
   * are held in memory.
   *
   * Archive entry names are logical relative paths produced by
   * `safeArchivePath` and never contain absolute filesystem paths or `..`
   * traversal. Empty live folders are included as directory entries.
   *
   * This method is infrastructure-only: it does NOT touch the download counter
   * or maxDownloads. Callers decide admission timing.
   */
  async streamFolderArchive(
    share: ShareLinkEntity,
    destination: Writable,
  ): Promise<void> {
    const members = await this.listArchiveMembers(share);
    const archive = archiver("zip", { zlib: { level: 0 } });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (err?: Error | null) => {
        if (settled) return;
        settled = true;
        archive.off("error", onError);
        if (err) reject(err);
        else resolve();
      };

      const onError = (err: Error) => finish(err);
      archive.on("error", onError);

      archive.on("end", () => finish());
      archive.on("finish", () => finish());

      archive.pipe(destination);

      let cancelled = false;
      destination.on("close", () => {
        cancelled = true;
        finish();
      });
      destination.on("error", (err: Error) => finish(err));

      (async () => {
        try {
          for (const member of members) {
            if (cancelled) break;

            const entryName = SharingService.safeArchivePath(member.logicalPath) || member.name;

            if (member.isFolder) {
              // Record an empty directory entry without triggering readdir-glob
              // (which pulls in lazystream/readable-stream and is incompatible
              // with the project's Node 20 runtime).
              archive.append(Buffer.alloc(0), {
                name: member.logicalPath === "" ? "./" : `${entryName}/`,
                type: "directory",
              } as any);
              continue;
            }

            if (!member.storagePath) {
              throw new BadRequestException(
                `Archive member ${member.name} has no storage path`,
              );
            }

            const safePath = this.storageService.ensureWithinStorageRoot(member.storagePath);
            const realPath = this.storageService.ensureWithinStorageRoot(
              fs.realpathSync(safePath),
            );
            const fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

            try {
              const stat = fs.fstatSync(fd);
              if (!stat.isFile()) {
                fs.closeSync(fd);
                throw new NotFoundException("File not found on storage");
              }
              // Stream the member through archiver without buffering it.
              // fs.createReadStream closes the fd when the stream ends, so the
              // fd lifecycle is owned by the stream from here.
              const memberStream = fs.createReadStream(realPath, {
                fd,
                autoClose: true,
              });
              archive.append(memberStream, {
                name: entryName,
                stats: stat,
              });
            } catch (err) {
              try {
                fs.closeSync(fd);
              } catch {
                /* fd may already be closed */
              }
              throw err;
            }
          }

          await archive.finalize();
        } catch (err) {
          finish(err as Error);
        }
      })();
    });
  }
}
