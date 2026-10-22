import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { createHash } from "node:crypto";
import { PublicFolderService } from "./public-folder.service";
import { UploadsService } from "../uploads/uploads.service";
import { PublicUploadAccess } from "../uploads/public-upload-access";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FileEntity } from "../entities/file.entity";
import { UploadThrottleException } from "../uploads/upload-rate-limit";
import { IngressChunkFile } from "../uploads/chunk-ingress";

export interface PublicSessionInput {
  parentId: number;
  filename: string;
  totalSize: number;
  chunkSize: number;
  expectedSha256?: string;
}

@Injectable()
export class PublicUploadsService {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(PublicUploadsService.name);
  constructor(
    private readonly db: DataSource,
    private readonly folders: PublicFolderService,
    private readonly uploads: UploadsService,
  ) {}

  private access(token: string, proof: string | undefined): PublicUploadAccess {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(token))
      throw new NotFoundException("Share unavailable");
    this.uploads.assertPublicLegacy();
    const auth = this.folders.uploadProof(proof);
    return {
      userId: auth.userId,
      shareLinkId: auth.shareId,
      shareRootFolderId: auth.rootId,
      authorize: (manager, parentId, lock) =>
        this.folders
          .authorizeUpload(manager, token, proof, parentId, lock)
          .then(() => undefined),
    };
  }

  private uploadId(value: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new NotFoundException("Upload unavailable");
  }

  private async checkResult(
    session: UploadSessionEntity,
    access: PublicUploadAccess,
    manager = this.db.manager,
  ) {
    if (session.status === "completed") {
      const file = await manager.findOne(FileEntity, {
        where: {
          uploadId: session.uploadId,
          userId: access.userId,
          isDeleted: false,
        },
      });
      if (!file?.parentId) throw new NotFoundException("File unavailable");
      await access.authorize(manager, file.parentId, false);
      if (file.parentId !== session.parentId)
        throw new ConflictException("Uploaded file moved; tree resume requires review");
    } else if (session.expiresAt && session.expiresAt <= new Date())
      throw new ConflictException("Upload expired");
  }

  async create(
    token: string,
    proof: string | undefined,
    key: string | undefined,
    input: PublicSessionInput,
  ) {
    const access = this.access(token, proof);
    if (
      !key ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      )
    )
      throw new BadRequestException("Idempotency-Key must be a UUID");
    if (
      !Number.isSafeInteger(input?.parentId) ||
      input.parentId <= 0 ||
      typeof input?.filename !== "string"
    )
      throw new BadRequestException("Invalid target or filename");
    await access.authorize(this.db.manager, input.parentId, false);
    const filename = input.filename.normalize("NFC").trim();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "upload_session",
          access.shareLinkId,
          access.shareRootFolderId,
          input.parentId,
          filename,
          input.totalSize,
          input.chunkSize,
          input.expectedSha256 ?? null,
        ]),
      )
      .digest("hex");
    access.replay = async (manager) => {
      const [prior] = await manager.query(
        `SELECT "requestSha256","resultUploadSessionId","expiresAt"
        FROM public_share_operations WHERE "shareLinkId"=$1 AND kind='upload_session' AND "idempotencyKey"=$2`,
        [access.shareLinkId, key],
      );
      if (prior) {
        if (
          prior.requestSha256 !== fingerprint ||
          new Date(prior.expiresAt) <= new Date()
        )
          throw new ConflictException("Idempotency key already used");
        const session =
          prior.resultUploadSessionId &&
          (await manager.findOne(UploadSessionEntity, {
            where: {
              id: prior.resultUploadSessionId,
              origin: "public",
              userId: access.userId,
              shareLinkId: access.shareLinkId,
              shareRootFolderId: access.shareRootFolderId,
            },
          }));
        if (!session) throw new NotFoundException("Upload unavailable");
        await this.checkResult(session, access, manager);
        return session;
      }
      const [{ receipts }] = await manager.query(
        `SELECT count(*)::int AS receipts FROM public_share_operations WHERE "shareLinkId"=$1`,
        [access.shareLinkId],
      );
      const [{ pending }] = await manager.query(
        `SELECT count(*)::int AS pending FROM upload_sessions
        WHERE "userId"=$1 AND status IN ('pending','uploading')`,
        [access.userId],
      );
      if (receipts >= 1000 || pending >= 128)
        throw new UploadThrottleException(60);
      return null;
    };
    access.receipt = async (manager, session) => {
      await access.authorize(manager, input.parentId, false);
      await manager.query(
        `INSERT INTO public_share_operations
        ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
        VALUES ($1,$2,$3,'upload_session',$4,$5,$6,clock_timestamp()+interval '24 hours')`,
        [
          access.shareLinkId,
          access.shareRootFolderId,
          access.userId,
          key,
          fingerprint,
          session.id,
        ],
      );
    };
    const session = await this.uploads.createUploadSession(
      access.userId,
      filename,
      input.totalSize,
      input.chunkSize,
      input.parentId,
      input.expectedSha256,
      access,
    );
    return this.uploads.toSessionMetadata(session);
  }

  async authorizeRequest(token: string, proof: string | undefined) {
    const access = this.access(token, proof);
    await access.authorize(this.db.manager, access.shareRootFolderId, false);
  }

  /** Live admission is performed before Multer allocates ingress bytes. */
  async admit(token: string, proof: string | undefined, uploadId: string) {
    this.uploadId(uploadId);
    const access = this.access(token, proof);
    const session = await this.uploads.getUploadSession(
      access.userId,
      uploadId,
      access,
    );
    return { userId: access.userId, session };
  }

  async chunk(
    token: string,
    proof: string | undefined,
    uploadId: string,
    chunkIndex: number,
    chunk: IngressChunkFile | Buffer,
  ) {
    this.uploadId(uploadId);
    const access = this.access(token, proof);
    const session = await this.uploads.uploadChunk(
      access.userId,
      uploadId,
      chunkIndex,
      chunk,
      undefined,
      access,
    );
    return this.uploads.toSessionMetadata(session);
  }

  async status(token: string, proof: string | undefined, uploadId: string) {
    this.uploadId(uploadId);
    const access = this.access(token, proof);
    return this.uploads.reconcileUploadSession(access.userId, uploadId, access);
  }

  async complete(token: string, proof: string | undefined, uploadId: string) {
    this.uploadId(uploadId);
    const access = this.access(token, proof);
    const file = await this.uploads.completeUpload(
      access.userId,
      uploadId,
      access,
    );
    return {
      id: file.id,
      name: file.name,
      parentId: file.parentId,
      size: Number(file.size),
      mimeType: file.mimeType,
      checksum: file.checksum,
      uploadId: file.uploadId,
    };
  }

  async abort(token: string, proof: string | undefined, uploadId: string) {
    this.uploadId(uploadId);
    const access = this.access(token, proof);
    await this.uploads.abortUpload(access.userId, uploadId, access);
    return { status: "aborted" };
  }

  async cleanupReceipts(): Promise<void> {
    await this.db.query(`DELETE FROM public_share_operations WHERE id IN
      (SELECT id FROM public_share_operations WHERE "expiresAt"<clock_timestamp()
       ORDER BY "expiresAt" LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      this.cleanupReceipts().catch(() =>
        this.logger.warn("Receipt cleanup deferred"),
      );
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
