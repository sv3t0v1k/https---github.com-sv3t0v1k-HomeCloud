import * as path from "node:path";
import { DataSource, EntityManager } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  SSD_UPLOAD_WORKSPACE_ID,
} from "../entities/upload-workspace.entity";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";
import {
  FinalizationBinding,
  FinalizationChunk,
  FinalizationOperation,
  FinalizationStore,
} from "./ssd-finalization-contract";

interface JournalRow extends Omit<FinalizationOperation, "totalSize"> {
  totalSize: string;
  state: string;
  fileId: number | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const sessionColumns = `id,"userId","uploadId",filename,"parentId","totalSize","chunkSize","totalChunks","uploadedCount","uploadedSize","accountingInitialized","workspaceId",status,"expiresAt"`;

/** Isolated caller only. No injectable provider, route, cleanup or recovery entry point. */
export class PostgresSsdFinalizationStore implements FinalizationStore {
  constructor(private readonly db: DataSource) {}

  private validateBinding(binding: FinalizationBinding): void {
    if (
      binding.sourceWorkspaceId !== SSD_UPLOAD_WORKSPACE_ID ||
      binding.targetStorageId !== LEGACY_STORAGE_ID
    )
      throw new Error("Invalid finalization identities");
    for (const key of [
      "sourceRoot",
      "sourcePath",
      "targetRoot",
      "temporaryPath",
      "storagePath",
    ] as const) {
      const value = binding[key];
      if (
        typeof value !== "string" ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value.includes("\0") ||
        value.length > 500
      )
        throw new Error("Invalid finalization path");
    }
    for (const key of [
      "sourceDevice",
      "sourceInode",
      "targetDevice",
      "targetInode",
      "sourceDirectoryDevice",
      "sourceDirectoryInode",
      "targetDirectoryDevice",
      "targetDirectoryInode",
    ] as const) {
      if (!/^(0|[1-9][0-9]*)$/.test(binding[key]))
        throw new Error("Invalid filesystem identity");
    }
    if (
      binding.sourceDevice === binding.targetDevice ||
      binding.sourceDirectoryDevice !== binding.sourceDevice ||
      binding.targetDirectoryDevice !== binding.targetDevice ||
      binding.sourceRoot === binding.targetRoot ||
      !binding.sourcePath.startsWith(binding.sourceRoot + path.sep) ||
      !binding.storagePath.startsWith(binding.targetRoot + path.sep) ||
      !binding.temporaryPath.startsWith(binding.targetRoot + path.sep) ||
      path.dirname(binding.temporaryPath) !==
        path.dirname(binding.storagePath) ||
      binding.temporaryPath === binding.storagePath ||
      path.relative(binding.targetRoot, binding.storagePath) !==
        binding.relativeObjectKey ||
      binding.relativeObjectKey
        .split(path.sep)
        .some((part) => !part || part === "." || part === "..") ||
      binding.relativeObjectKey.startsWith(".tmp/") ||
      binding.relativeObjectKey.startsWith(".restore-")
    )
      throw new Error("Invalid finalization placement");
  }

  private operation(row: JournalRow): FinalizationOperation {
    const totalSize = Number(row.totalSize);
    if (!Number.isSafeInteger(totalSize))
      throw new Error("Unsafe finalization size");
    return {
      id: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      uploadId: row.uploadId,
      filename: row.filename,
      parentId: row.parentId,
      totalSize,
      chunkSize: row.chunkSize,
      totalChunks: row.totalChunks,
      expectedSha256: row.expectedSha256,
      binding: row.binding,
    };
  }

  async begin(input: {
    id: string;
    userId: number;
    uploadId: string;
    expectedSha256: string;
    binding: FinalizationBinding;
  }): Promise<FinalizationOperation> {
    if (
      !uuid.test(input.id) ||
      !uuid.test(input.uploadId) ||
      !Number.isSafeInteger(input.userId) ||
      input.userId <= 0 ||
      !hash.test(input.expectedSha256)
    )
      throw new Error("Invalid finalization request");
    this.validateBinding(input.binding);
    if (
      input.binding.sourcePath !==
        path.join(input.binding.sourceRoot, input.uploadId) ||
      input.binding.relativeObjectKey !==
        `${input.userId}/${input.id}.ssd-finalized` ||
      input.binding.temporaryPath !==
        path.join(
          input.binding.targetRoot,
          String(input.userId),
          `.${input.id}.assembling`,
        )
    )
      throw new Error("Invalid isolated finalization paths");
    return this.db.transaction(async (manager) => {
      await this.requireDurability(manager);
      const sessions = await manager.query(
        `SELECT ${sessionColumns} FROM upload_sessions WHERE "userId"=$1 AND "uploadId"=$2 FOR UPDATE`,
        [input.userId, input.uploadId],
      );
      if (sessions.length !== 1)
        throw new Error("Unique owned upload session required");
      const session = sessions[0];
      const totalSize = Number(session.totalSize);
      if (
        session.workspaceId !== LEGACY_UPLOAD_WORKSPACE_ID ||
        !["pending", "uploading"].includes(session.status) ||
        !session.accountingInitialized ||
        !Number.isSafeInteger(totalSize) ||
        totalSize <= 0 ||
        !Number.isSafeInteger(session.chunkSize) ||
        session.chunkSize <= 0 ||
        !Number.isSafeInteger(session.totalChunks) ||
        session.totalChunks <= 0 ||
        session.totalChunks !== Math.ceil(totalSize / session.chunkSize) ||
        session.uploadedCount !== session.totalChunks ||
        Number(session.uploadedSize) !== totalSize ||
        (session.expiresAt &&
          new Date(session.expiresAt).getTime() <= Date.now())
      )
        throw new Error("Upload manifest metadata is not complete");
      if (
        (
          await manager.query(
            `SELECT 1 FROM files WHERE "userId"=$1 AND "uploadId"=$2`,
            [input.userId, input.uploadId],
          )
        ).length
      )
        throw new Error("Upload already has a File");
      const layout = (
        await manager.query(
          `SELECT count(*)::int AS count, min("chunkIndex") AS minimum, max("chunkIndex") AS maximum,
        COALESCE(sum("byteSize"),0)::text AS bytes,
        count(*) FILTER (WHERE sha256 !~ '^[0-9a-f]{64}$' OR "chunkIndex">=$2 OR "byteSize" <> CASE WHEN "chunkIndex"=$2-1 THEN $3::bigint-"chunkIndex"::bigint*$4 ELSE $4 END)::int AS invalid
        FROM upload_chunks WHERE "sessionId"=$1`,
          [session.id, session.totalChunks, totalSize, session.chunkSize],
        )
      )[0];
      if (
        layout.count !== session.totalChunks ||
        layout.minimum !== 0 ||
        layout.maximum !== session.totalChunks - 1 ||
        Number(layout.bytes) !== totalSize ||
        layout.invalid !== 0
      )
        throw new Error("Upload chunk manifest is invalid");
      await this.validateOwnerAndParent(
        manager,
        input.userId,
        session.parentId,
      );
      const [row] = await manager.query(
        `INSERT INTO ssd_finalization_operations
        (id,"sessionId","userId","uploadId",filename,"parentId","totalSize","chunkSize","totalChunks","expectedSha256",binding)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
        [
          input.id,
          session.id,
          input.userId,
          session.uploadId,
          session.filename,
          session.parentId,
          totalSize,
          session.chunkSize,
          session.totalChunks,
          input.expectedSha256,
          JSON.stringify(input.binding),
        ],
      );
      await manager.query(
        `INSERT INTO ssd_finalization_chunks ("operationId","chunkIndex","byteSize",sha256)
        SELECT $1,"chunkIndex","byteSize",sha256 FROM upload_chunks WHERE "sessionId"=$2`,
        [input.id, session.id],
      );
      return this.operation(row);
    });
  }

  async *chunks(operationId: string): AsyncIterable<FinalizationChunk> {
    if (!uuid.test(operationId)) throw new Error("Invalid operation identity");
    let after = -1;
    while (true) {
      const rows: FinalizationChunk[] = await this.db.query(
        `SELECT "chunkIndex","byteSize",sha256 FROM ssd_finalization_chunks
        WHERE "operationId"=$1 AND "chunkIndex">$2 ORDER BY "chunkIndex" LIMIT 128`,
        [operationId, after],
      );
      if (!rows.length) return;
      for (const row of rows) {
        after = row.chunkIndex;
        yield row;
      }
    }
  }

  async transition(
    operationId: string,
    from: "assembling" | "verified" | "publishing",
    to: "verified" | "publishing" | "published",
  ): Promise<void> {
    await this.db.transaction(async (manager) => {
      await this.requireDurability(manager);
      const rows = await manager.query(
        `WITH changed AS (UPDATE ssd_finalization_operations SET state=$3,"updatedAt"=now() WHERE id=$1 AND state=$2 RETURNING id) SELECT id FROM changed`,
        [operationId, from, to],
      );
      if (rows.length !== 1) throw new Error("Finalization state conflict");
    });
  }

  private async requireDurability(manager: EntityManager): Promise<void> {
    await manager.query(`SET LOCAL synchronous_commit = on`);
    const [settings] = await manager.query(
      `SELECT current_setting('fsync') AS fsync`,
    );
    if (settings.fsync !== "on")
      throw new Error("Durable finalization requires PostgreSQL fsync=on");
  }

  private async validateOwnerAndParent(
    manager: EntityManager,
    userId: number,
    parentId: number | null,
  ): Promise<{ storageUsed: string; storageQuota: string }> {
    const [owner] = await manager.query(
      `SELECT "storageUsed","storageQuota","isActive" FROM users WHERE id=$1 FOR UPDATE`,
      [userId],
    );
    if (!owner || !owner.isActive)
      throw new Error("Finalization owner unavailable");
    if (parentId !== null) {
      const [parent] = await manager.query(
        `SELECT "userId","isDeleted" FROM folders WHERE id=$1 FOR UPDATE`,
        [parentId],
      );
      if (!parent || parent.userId !== userId || parent.isDeleted)
        throw new Error("Finalization parent unavailable");
    }
    return owner;
  }

  async commit(operationId: string): Promise<FileEntity> {
    return this.db.transaction(async (manager) => {
      await this.requireDurability(manager);
      const [row]: JournalRow[] = await manager.query(
        `SELECT * FROM ssd_finalization_operations WHERE id=$1 FOR UPDATE`,
        [operationId],
      );
      if (!row || row.state !== "published")
        throw new Error("Finalization requires published operation");
      const [session] = await manager.query(
        `SELECT ${sessionColumns} FROM upload_sessions WHERE id=$1 FOR UPDATE`,
        [row.sessionId],
      );
      const operation = this.operation(row);
      this.validateBinding(operation.binding);
      if (
        !session ||
        !["pending", "uploading"].includes(session.status) ||
        session.userId !== row.userId ||
        session.uploadId !== row.uploadId ||
        session.filename !== row.filename ||
        session.parentId !== row.parentId ||
        String(session.totalSize) !== String(row.totalSize) ||
        session.chunkSize !== row.chunkSize ||
        session.totalChunks !== row.totalChunks ||
        session.uploadedCount !== row.totalChunks ||
        String(session.uploadedSize) !== String(row.totalSize) ||
        !session.accountingInitialized ||
        session.workspaceId !== LEGACY_UPLOAD_WORKSPACE_ID
      )
        throw new Error("Finalization session changed");
      const owner = await this.validateOwnerAndParent(
        manager,
        row.userId,
        row.parentId,
      );
      if (
        BigInt(owner.storageUsed) + BigInt(row.totalSize) >
        BigInt(owner.storageQuota)
      )
        throw new Error("Finalization quota exceeded");
      if (
        (
          await manager.query(
            `SELECT 1 FROM files WHERE "userId"=$1 AND "uploadId"=$2`,
            [row.userId, row.uploadId],
          )
        ).length
      )
        throw new Error("Upload already has a File");
      const [{ id }]: Array<{ id: number }> = await manager.query(
        `SELECT nextval(pg_get_serial_sequence('files','id'))::int AS id`,
      );
      await manager.query(
        `UPDATE ssd_finalization_operations SET state='committed',"fileId"=$2,"updatedAt"=now() WHERE id=$1`,
        [operationId, id],
      );
      const [file] = await manager.query(
        `INSERT INTO files
        (id,name,"storagePath","storageLocationId","relativeObjectKey",size,"mimeType",checksum,"parentId","userId","uploadId")
        VALUES ($1,$2,$3,$4,$5,$6,'application/octet-stream',$7,$8,$9,$10) RETURNING *`,
        [
          id,
          row.filename,
          row.binding.storagePath,
          row.binding.targetStorageId,
          row.binding.relativeObjectKey,
          row.totalSize,
          row.expectedSha256,
          row.parentId,
          row.userId,
          row.uploadId,
        ],
      );
      await manager.query(
        `UPDATE users SET "storageUsed"="storageUsed"+$2::bigint,"updatedAt"=now() WHERE id=$1`,
        [row.userId, row.totalSize],
      );
      await manager.query(
        `UPDATE upload_sessions SET status='completed',"updatedAt"=now() WHERE id=$1`,
        [row.sessionId],
      );
      return Object.assign(new FileEntity(), file, {
        size: operation.totalSize,
      });
    });
  }
}
