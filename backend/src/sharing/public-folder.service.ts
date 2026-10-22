import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SharingService } from "./sharing.service";
import { allocateNamespaceName } from "../files/namespace-name";

export interface UploadProof {
  aud: "public-folder-write";
  shareId: number;
  rootId: number;
  userId: number;
  expires: number;
}

@Injectable()
export class PublicFolderService {
  private readonly proofKey: Buffer;

  constructor(
    private readonly db: DataSource,
    private readonly shares: SharingService,
    config: ConfigService,
  ) {
    const secret = config.get<string>("JWT_SECRET");
    if (!secret)
      throw new Error("JWT_SECRET is required for public folder proofs");
    this.proofKey = createHash("sha256")
      .update("homecloud-public-folder-proof-v1\0")
      .update(secret)
      .digest();
  }

  async authorize(token: string, password = "") {
    const share = await this.shares.findShareByToken(token);
    if (!share.isFolder || !share.allowUpload || !share.file.folderId)
      throw new ForbiddenException("Public folder writing is not allowed");
    if (share.password) await this.shares.verifySharePassword(token, password);
    const expires = Math.min(
      Date.now() + 5 * 60_000,
      share.expiresAt?.getTime() ?? Infinity,
    );
    if (expires <= Date.now())
      throw new NotFoundException("Share link unavailable");
    const payload: UploadProof = {
      aud: "public-folder-write",
      shareId: share.id,
      rootId: share.file.folderId,
      userId: share.userId,
      expires,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.proofKey)
      .update(encoded)
      .digest("base64url");
    return {
      proof: `${encoded}.${signature}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  private verifyProof(proof: string | undefined): UploadProof {
    if (
      !proof ||
      proof.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof)
    )
      throw new ForbiddenException("Public folder authorization required");
    const [payload, signature] = proof.split(".");
    const expected = createHmac("sha256", this.proofKey)
      .update(payload)
      .digest();
    const supplied = Buffer.from(signature, "base64url");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new ForbiddenException("Invalid public folder authorization");
    let decoded: UploadProof;
    try {
      decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as UploadProof;
    } catch {
      throw new ForbiddenException("Invalid public folder authorization");
    }
    if (
      decoded.aud !== "public-folder-write" ||
      !Number.isSafeInteger(decoded.shareId) ||
      !Number.isSafeInteger(decoded.rootId) ||
      !Number.isSafeInteger(decoded.userId) ||
      !Number.isSafeInteger(decoded.expires) ||
      decoded.expires <= Date.now()
    )
      throw new ForbiddenException(
        "Public folder authorization expired or invalid",
      );
    return decoded;
  }

  private validateName(value: unknown): string {
    if (typeof value !== "string")
      throw new BadRequestException("Folder name is required");
    const name = value.normalize("NFC").trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      [...name].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })
    )
      throw new BadRequestException("Invalid folder name");
    return name;
  }

  private async livePath(
    manager: EntityManager,
    userId: number,
    targetId: number,
    rootId: number,
  ) {
    const rows: { id: number; parentId: number | null }[] = await manager.query(
      `WITH RECURSIVE ancestors AS (
      SELECT f.id,f."parentId",ARRAY[f.id] AS path FROM folders f
      JOIN files mirror ON mirror."folderId"=f.id
      WHERE f.id=$1 AND f."userId"=$2 AND NOT f."isDeleted"
        AND mirror."userId"=$2 AND mirror."isFolder" AND NOT mirror."isDeleted"
      UNION ALL
      SELECT f.id,f."parentId",ancestors.path||f.id FROM folders f
      JOIN ancestors ON ancestors."parentId"=f.id
      JOIN files mirror ON mirror."folderId"=f.id
      WHERE f."userId"=$2 AND NOT f."isDeleted" AND mirror."userId"=$2
        AND mirror."isFolder" AND NOT mirror."isDeleted"
        AND NOT f.id=ANY(ancestors.path) AND cardinality(ancestors.path)<128
    ) SELECT id,"parentId" FROM ancestors`,
      [targetId, userId],
    );
    const ids = rows.map((row) => row.id);
    if (!ids.includes(rootId) || !rows.some(row => row.parentId === null))
      throw new NotFoundException("Folder unavailable");
    return ids;
  }

  private async lockLivePath(
    manager: EntityManager,
    userId: number,
    targetId: number,
    rootId: number,
  ) {
    const ids = await this.livePath(manager, userId, targetId, rootId);
    await manager.query(
      `SELECT id FROM folders WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    await manager.query(
      `SELECT id FROM files WHERE "folderId"=ANY($1::integer[]) ORDER BY id FOR SHARE`,
      [ids],
    );
    await this.livePath(manager, userId, targetId, rootId);
  }

  uploadProof(proof: string | undefined): UploadProof { return this.verifyProof(proof); }

  async authorizeUpload(manager: EntityManager, token: string, proof: string | undefined, parentId: number, lock = false): Promise<UploadProof> {
    const auth = this.verifyProof(proof);
    if (!Number.isSafeInteger(parentId) || parentId <= 0) throw new NotFoundException("Folder unavailable");
    const [link] = await manager.query(`SELECT link.id,link."userId",mirror."folderId" AS root
      FROM share_links link JOIN files mirror ON mirror.id=link."fileId"
      JOIN users owner ON owner.id=link."userId"
      JOIN folders root ON root.id=mirror."folderId"
      WHERE link.token=$1 AND link."isActive" AND link."allowUpload" AND link."isFolder"
        AND (link."expiresAt" IS NULL OR link."expiresAt">clock_timestamp())
        AND mirror."userId"=link."userId" AND mirror."isFolder" AND NOT mirror."isDeleted"
        AND root."userId"=link."userId" AND NOT root."isDeleted" AND owner."isActive"
      ${lock ? "FOR UPDATE OF link" : ""}`, [token]);
    if (!link || link.id !== auth.shareId || link.userId !== auth.userId || link.root !== auth.rootId)
      throw new NotFoundException("Share link unavailable");
    if (lock) await this.lockLivePath(manager, auth.userId, parentId, auth.rootId);
    else await this.livePath(manager, auth.userId, parentId, auth.rootId);
    return auth;
  }

  async createFolder(
    token: string,
    proof: string | undefined,
    key: string | undefined,
    input: { parentId?: unknown; name?: unknown },
  ) {
    const authorization = this.verifyProof(proof);
    if (
      !key ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      )
    )
      throw new BadRequestException("Idempotency-Key must be a UUID");
    const parentId = input?.parentId;
    if (
      typeof parentId !== "number" ||
      !Number.isSafeInteger(parentId) ||
      parentId <= 0
    )
      throw new BadRequestException("Valid parentId is required");
    const name = this.validateName(input?.name);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "mkdir",
          authorization.shareId,
          authorization.rootId,
          parentId,
          name,
        ]),
      )
      .digest("hex");
    return this.db.transaction(async (manager) => {
      // Upload publication and all owner metadata mutations acquire user first.
      await manager.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [authorization.userId]);
      // The share row serializes revoke, retry, and concurrent public creations.
      const links = await manager.query(
        `SELECT link.id,link."userId",mirror."folderId" AS root
        FROM share_links link JOIN files mirror ON mirror.id=link."fileId"
        JOIN users owner ON owner.id=link."userId"
        JOIN folders root ON root.id=mirror."folderId"
        WHERE link.token=$1 AND link."isActive" AND link."allowUpload" AND link."isFolder"
          AND (link."expiresAt" IS NULL OR link."expiresAt">clock_timestamp())
          AND mirror."userId"=link."userId" AND mirror."isFolder" AND NOT mirror."isDeleted"
          AND root."userId"=link."userId" AND NOT root."isDeleted" AND owner."isActive"
        FOR UPDATE OF link`,
        [token],
      );
      const link = links[0];
      if (
        !link ||
        link.id !== authorization.shareId ||
        link.userId !== authorization.userId ||
        link.root !== authorization.rootId
      )
        throw new NotFoundException("Share link unavailable");
      // Foreign-key inserts also need a user KEY SHARE lock. Acquire it before
      // folder locks, matching owner upload finalization's user -> folder order.

      // Lock the live chain and mirrors, then recheck after possible concurrent moves.
      await this.lockLivePath(manager, link.userId, parentId, link.root);
      const prior = await manager.query(
        `SELECT "requestSha256","resultFolderId","expiresAt" FROM public_share_operations
        WHERE "shareLinkId"=$1 AND kind='mkdir' AND "idempotencyKey"=$2`,
        [link.id, key],
      );
      if (prior.length) {
        if (
          prior[0].requestSha256 !== requestHash ||
          new Date(prior[0].expiresAt).getTime() <= Date.now()
        )
          throw new ConflictException("Idempotency key already used");
        if (!prior[0].resultFolderId)
          throw new NotFoundException("Folder unavailable");
        await this.lockLivePath(
          manager,
          link.userId,
          prior[0].resultFolderId,
          link.root,
        );
        const existing = await manager.query(
          `SELECT id,name,"parentId" FROM folders
          WHERE id=$1 AND "userId"=$2 AND NOT "isDeleted"`,
          [prior[0].resultFolderId, link.userId],
        );
        if (!existing.length) throw new NotFoundException("Folder unavailable");
        if (existing[0].parentId !== parentId)
          throw new ConflictException("Created folder moved; tree resume requires review");
        return {
          id: existing[0].id,
          parentId: existing[0].parentId,
          name: existing[0].name,
        };
      }
      const [{ used }] = await manager.query(
        `SELECT count(*)::int AS used FROM public_share_operations
         WHERE "shareLinkId"=$1`,
        [link.id],
      );
      if (used >= 1000)
        throw new HttpException(
          "Public folder creation limit reached",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const chosen = await allocateNamespaceName(manager, link.userId, parentId, name, "folder");
      // The previous path check remains valid because every ancestor and mirror is locked.
      const [folder] = await manager.query(
        `INSERT INTO folders(name,"parentId","userId")
        SELECT $1,$2,$3 FROM share_links live
        WHERE live.id=$4 AND live."isActive" AND live."allowUpload"
          AND (live."expiresAt" IS NULL OR live."expiresAt">clock_timestamp())
        RETURNING id`,
        [chosen, parentId, link.userId, link.id],
      );
      if (!folder) throw new NotFoundException("Share link unavailable");
      await manager.query(
        `INSERT INTO files(name,"isFolder","parentId","folderId","userId",version)
        VALUES ($1,true,$2,$3,$4,1)`,
        [chosen, parentId, folder.id, link.userId],
      );
      await manager.query(
        `INSERT INTO public_share_operations
        ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultFolderId","expiresAt")
        VALUES ($1,$2,$3,'mkdir',$4,$5,$6,clock_timestamp()+interval '24 hours')`,
        [link.id, link.root, link.userId, key, requestHash, folder.id],
      );
      return { id: folder.id, parentId, name: chosen };
    });
  }
}
