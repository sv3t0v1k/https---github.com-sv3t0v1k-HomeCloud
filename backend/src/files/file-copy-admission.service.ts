import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

export interface CopyAdmissionRequest {
  userId: number;
  sourceFileId: number;
  storageLocationId: string;
  relativeObjectKey: string;
  bytes: number;
  signal?: AbortSignal;
}

/** Database-only diagnostic. Does not prove filesystem ownership. */
export interface CopyRecoveryAuditRecord {
  id: string;
  userId: number;
  sourceFileId: number;
  storageLocationId: string;
  relativeObjectKey: string;
  bytes: string;
  state: "reserved" | "cleanup_required";
  createdAt: Date;
  updatedAt: Date;
  metadataPresent: boolean;
  cleanupClaimed: boolean;
}

@Injectable()
export class FileCopyAdmissionService {
  private static readonly GLOBAL_LIMIT = 4;

  constructor(private readonly database: DataSource) {}

  /**
   * The callback MUST verify durable removal of the exact destination
   * owned by this operation. Never pass a generic pathname unlink.
   *
   * Database state is fenced before cleanup. A failed cleanup
   * preserves the reservation and both admission limits.
   */
  /**
   * Inspect a bounded set of unresolved reservations.
   * This is NOT permission to unlink a destination or release quota.
   */
  async inspectUnresolved(limit = 100): Promise<CopyRecoveryAuditRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Invalid copy audit limit");
    }

    return this.database.query(
      `SELECT
         op.id,
         op."userId",
         op."sourceFileId",
         op."storageLocationId",
         op."relativeObjectKey",
         op.bytes::text AS bytes,
         op.state,
         (op."cleanupClaimId" IS NOT NULL) AS "cleanupClaimed",
         op."createdAt",
         op."updatedAt",
         EXISTS (
           SELECT 1 FROM files f
           WHERE f."userId" = op."userId"
             AND f."storageLocationId" = op."storageLocationId"
             AND f."relativeObjectKey" = op."relativeObjectKey"
         ) AS "metadataPresent"
       FROM file_copy_operations op
       WHERE op.state IN ('reserved', 'cleanup_required')
       ORDER BY op."createdAt" ASC, op.id ASC
       LIMIT $1`,
      [limit],
    );
  }

  async releaseAfterOwnedCleanup(
    operationId: string,
    userId: number,
    cleanupOwnedDestination: () => void | Promise<void>,
  ): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        operationId,
      ) ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      userId > 2147483647 ||
      typeof cleanupOwnedDestination !== "function"
    ) {
      throw new BadRequestException("Invalid copy cleanup identity");
    }

    // No physical cleanup until the DB has durably fenced publication.
    const claimId = randomUUID();

    const prepared: Array<{ id: string }> = await this.database.query(
      `WITH updated AS (
         UPDATE file_copy_operations op
         SET state = 'cleanup_required',
             "cleanupClaimId" = $3::uuid,
             "updatedAt" = now()
         WHERE op.id = $1::uuid
           AND op."userId" = $2
           AND op.state IN ('reserved', 'cleanup_required')
           AND op."cleanupClaimId" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM files f
             WHERE f."userId" = op."userId"
               AND f."storageLocationId" = op."storageLocationId"
               AND f."relativeObjectKey" = op."relativeObjectKey"
           )
         RETURNING op.id
       )
       SELECT id FROM updated`,
      [operationId, userId, claimId],
    );

    if (prepared.length !== 1) {
      throw new ServiceUnavailableException("Copy cleanup not authorized");
    }

    // Do not hold PostgreSQL locks during filesystem operations.
    // On failure the operation remains cleanup_required.
    try {
      await cleanupOwnedDestination();
    } catch (error) {
      // The callback has stopped. Permit another explicitly authorized
      // attempt only if PostgreSQL confirms that this claim was cleared.
      // On database failure the claim remains durable and blocks retries.
      try {
        await this.database.query(
          `WITH updated AS (
             UPDATE file_copy_operations op
             SET "cleanupClaimId" = NULL,
                 "updatedAt" = now()
             WHERE op.id = $1::uuid
               AND op."userId" = $2
               AND op.state = 'cleanup_required'
               AND op."cleanupClaimId" = $3::uuid
             RETURNING op.id
           )
           SELECT id FROM updated`,
          [operationId, userId, claimId],
        );
      } catch {
        // Fail closed: the journal still carries this cleanup claim.
      }
      throw error;
    }

    const released: Array<{ id: string }> = await this.database.query(
      `WITH updated AS (
         UPDATE file_copy_operations op
         SET state = 'released',
             "cleanupClaimId" = NULL,
             "updatedAt" = now()
         WHERE op.id = $1::uuid
           AND op."userId" = $2
           AND op.state = 'cleanup_required'
           AND op."cleanupClaimId" = $3::uuid
           AND NOT EXISTS (
             SELECT 1 FROM files f
             WHERE f."userId" = op."userId"
               AND f."storageLocationId" = op."storageLocationId"
               AND f."relativeObjectKey" = op."relativeObjectKey"
           )
         RETURNING op.id
       )
       SELECT id FROM updated`,
      [operationId, userId, claimId],
    );

    if (released.length !== 1) {
      throw new ServiceUnavailableException(
        "Copy cleanup release not confirmed",
      );
    }
  }

  async markCommitted(
    manager: EntityManager,
    operationId: string,
    userId: number,
    fileId: number,
  ): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(operationId) ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !Number.isSafeInteger(fileId) ||
      fileId <= 0
    ) {
      throw new BadRequestException("Invalid copy publication identity");
    }

    // Must execute inside the caller's existing metadata transaction.
    // Both the file and its reservation become committed atomically.
    const rows: Array<{ id: string }> = await manager.query(
      `WITH updated AS (
         UPDATE file_copy_operations op
       SET state = 'committed',
           "resultFileId" = $3,
           "updatedAt" = now()
       WHERE op.id = $1::uuid
         AND op."userId" = $2
         AND op.state = 'reserved'
         AND EXISTS (
           SELECT 1 FROM files f
           WHERE f.id = $3
             AND f."userId" = op."userId"
             AND f."storageLocationId" = op."storageLocationId"
             AND f."relativeObjectKey" = op."relativeObjectKey"
             AND f.size = op.bytes
             AND NOT f."isDeleted"
             AND NOT f."isFolder"
         )
       RETURNING op.id
       )
       SELECT id FROM updated`,
      [operationId, userId, fileId],
    );

    if (rows.length !== 1) {
      throw new ServiceUnavailableException(
        "Copy reservation publication mismatch",
      );
    }
  }

  async reserve(request: CopyAdmissionRequest): Promise<string> {
    const {
      userId,
      sourceFileId,
      storageLocationId,
      relativeObjectKey,
      bytes,
      signal,
    } = request;

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      userId > 2147483647 ||
      !Number.isSafeInteger(sourceFileId) ||
      sourceFileId <= 0 ||
      sourceFileId > 2147483647 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      throw new BadRequestException("Invalid copy admission parameters");
    }

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        storageLocationId,
      ) ||
      typeof relativeObjectKey !== "string" ||
      relativeObjectKey.length === 0 ||
      relativeObjectKey.length > 500 ||
      relativeObjectKey
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      relativeObjectKey.includes("\\") ||
      relativeObjectKey.includes("\0")
    ) {
      throw new BadRequestException("Invalid copy placement");
    }

    const checkCancellation = () => {
      if (signal?.aborted) {
        throw new ServiceUnavailableException("File copy cancelled");
      }
    };

    checkCancellation();

    const operationId = randomUUID();
    const runner = this.database.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      await runner.query("SET LOCAL lock_timeout = '1500ms'");
      await runner.query("SET LOCAL statement_timeout = '2500ms'");

      // One database-wide mutex, held only during admission.
      // Never retain the lock while copying bytes.
      const gate = await runner.query(`
        SELECT id FROM file_copy_admission
        WHERE id = true
        FOR UPDATE
      `);

      if (gate.length !== 1) {
        throw new ServiceUnavailableException(
          "File copy admission unavailable",
        );
      }

      checkCancellation();

      const global = await runner.query(`
        SELECT COUNT(*)::int AS count
        FROM file_copy_operations
        WHERE state IN ('reserved', 'cleanup_required')
      `);

      if (Number(global[0]?.count) >= FileCopyAdmissionService.GLOBAL_LIMIT) {
        throw new ServiceUnavailableException(
          "Global file copy limit exceeded",
        );
      }

      // Shared user-row lock coordinates with upload admission.
      const owners = await runner.query(
        `SELECT id, "isActive", "storageUsed", "storageQuota"
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
      );

      if (owners.length !== 1 || !owners[0].isActive) {
        throw new ForbiddenException("User unavailable");
      }

      const copies = await runner.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(bytes), 0)::text AS bytes
         FROM file_copy_operations
         WHERE "userId" = $1
           AND state IN ('reserved', 'cleanup_required')`,
        [userId],
      );

      if (Number(copies[0]?.count) > 0) {
        throw new ServiceUnavailableException(
          "User file copy already in progress",
        );
      }

      const uploads = await runner.query(
        `SELECT COALESCE(SUM("totalSize"), 0)::text AS bytes
         FROM upload_sessions
         WHERE "userId" = $1
           AND status IN ('pending', 'uploading')`,
        [userId],
      );

      const used = BigInt(owners[0].storageUsed);
      const quota = BigInt(owners[0].storageQuota);
      const uploadBytes = BigInt(uploads[0]?.bytes ?? "0");
      const copyBytes = BigInt(copies[0]?.bytes ?? "0");

      if (used < 0n || quota < 0n || uploadBytes < 0n || copyBytes < 0n) {
        throw new ServiceUnavailableException("Invalid storage accounting");
      }

      if (used + uploadBytes + copyBytes + BigInt(bytes) > quota) {
        throw new ForbiddenException("Storage quota exceeded");
      }

      checkCancellation();

      await runner.query(
        `INSERT INTO file_copy_operations (
          "id", "userId", "sourceFileId",
          "storageLocationId", "relativeObjectKey",
          "bytes", "state"
        ) VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`,
        [
          operationId,
          userId,
          sourceFileId,
          storageLocationId,
          relativeObjectKey,
          bytes,
        ],
      );

      checkCancellation();

      try {
        await runner.commitTransaction();
      } catch {
        // The connection may have lost the COMMIT acknowledgement.
        // Reconcile through a separate database connection.
        // Never retry INSERT or release an uncertain reservation.
        let rows: Array<{
          userId: number;
          sourceFileId: number;
          storageLocationId: string;
          relativeObjectKey: string;
          bytes: string;
          state: string;
        }>;

        try {
          rows = await this.database.query(
            `SELECT "userId", "sourceFileId",
                    "storageLocationId", "relativeObjectKey",
                    "bytes"::text AS bytes, state
             FROM file_copy_operations
             WHERE id = $1`,
            [operationId],
          );
        } catch {
          throw new ServiceUnavailableException(
            "Copy reservation COMMIT outcome uncertain",
          );
        }

        if (
          rows.length === 1 &&
          Number(rows[0].userId) === userId &&
          Number(rows[0].sourceFileId) === sourceFileId &&
          rows[0].storageLocationId === storageLocationId.toLowerCase() &&
          rows[0].relativeObjectKey === relativeObjectKey &&
          rows[0].bytes === String(bytes) &&
          rows[0].state === "reserved"
        ) {
          return operationId;
        }

        // No matching committed reservation has been established.
        // An in-flight COMMIT may still complete later.
        // Fail closed and leave recovery to a separate procedure.
        throw new ServiceUnavailableException(
          "Copy reservation COMMIT not confirmed",
        );
      }

      return operationId;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }
  }
}
