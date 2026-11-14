import * as path from "node:path";
import { DataSource } from "typeorm";
import { StorageService } from "../storage/storage.service";

interface RecoveryRow {
  id: string;
  userId: number;
  storageLocationId: string;
  relativeObjectKey: string;
  state: string;
  resultFileId: number | null;
}

/**
 * Offline-only recovery primitive.
 *
 * PRECONDITION: an external host supervisor has stopped and fenced
 * ALL backend writers and disabled automatic restarts.
 *
 * Never expose this function through HTTP, Nest DI or scheduled jobs.
 * No inode is ever unlinked here.
 */
export async function releaseProvenAbsentOffline(
  database: DataSource,
  storage: StorageService,
  operationId: string,
  assertOfflineAdmission?: () => void,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("Offline copy recovery requires Linux");
  }

  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    throw new Error("Privileged copy recovery refused");
  }

  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  ) {
    throw new Error("Invalid copy recovery identity");
  }

  return storage.withCopyRecoveryRootLock(async () => {
    // CLI admission must be repeated under the exclusive root lock.
    assertOfflineAdmission?.();

    const runner = database.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      await runner.query("SET LOCAL lock_timeout = '1500ms'");
      await runner.query("SET LOCAL statement_timeout = '8000ms'");

      // Block new copy admissions during this recovery transaction.
      const gate = await runner.query(
        `SELECT id FROM file_copy_admission
       WHERE id = true FOR UPDATE`,
      );

      if (gate.length !== 1) {
        throw new Error("Copy admission gate unavailable");
      }

      const rows: RecoveryRow[] = await runner.query(
        `SELECT id, "userId", "storageLocationId",
              "relativeObjectKey", state, "resultFileId"
       FROM file_copy_operations
       WHERE id = $1::uuid
       FOR UPDATE`,
        [operationId],
      );

      if (rows.length !== 1) {
        throw new Error("Copy recovery operation not found");
      }

      const op = rows[0];

      if (
        !["reserved", "cleanup_required"].includes(op.state) ||
        op.resultFileId !== null
      ) {
        throw new Error("Copy recovery state is not releasable");
      }

      if (
        !Number.isSafeInteger(op.userId) ||
        op.userId <= 0 ||
        op.userId > 2147483647
      ) {
        throw new Error("Invalid copy recovery owner");
      }

      // This version copies only to <userId>/<filename>.
      // Do not reinterpret an arbitrary journal path.
      const parts = op.relativeObjectKey?.split("/");

      if (
        parts?.length !== 2 ||
        parts[0] !== String(op.userId) ||
        !parts[1] ||
        parts[1] === "." ||
        parts[1] === ".." ||
        parts[1].includes("\\") ||
        parts[1].includes("\0")
      ) {
        throw new Error("Copy recovery placement ownership mismatch");
      }

      const root = storage.getStoragePath();
      const destination = path.join(root, op.relativeObjectKey);
      const placement = storage.placementForPath(destination);

      if (
        placement.storageLocationId !== op.storageLocationId ||
        placement.relativeObjectKey !== op.relativeObjectKey ||
        placement.storagePath !== destination
      ) {
        throw new Error("Copy recovery storage identity mismatch");
      }

      const owner = await runner.query(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [op.userId],
      );

      if (owner.length !== 1) {
        throw new Error("Copy recovery owner disappeared");
      }

      // Prevent metadata insertion while checking physical absence.
      // This does NOT replace the external offline-writer fence.
      await runner.query("LOCK TABLE files IN SHARE MODE");

      const metadata = await runner.query(
        `SELECT id FROM files
       WHERE (
         "storageLocationId" = $1::uuid
         AND "relativeObjectKey" = $2
       ) OR "storagePath" = $3
       LIMIT 1`,
        [op.storageLocationId, op.relativeObjectKey, destination],
      );

      // Include soft-deleted and foreign-owner metadata.
      if (metadata.length !== 0) {
        throw new Error("Copy recovery metadata still references destination");
      }

      // Native pinned-root proof. Rejects any existing inode, symlink,
      // unsafe storage identity or directory fsync failure.
      assertOfflineAdmission?.();
      storage.confirmCopyDestinationAbsent(destination);

      const updated = await runner.query(
        `WITH updated AS (
         UPDATE file_copy_operations
         SET state = 'released',
             "cleanupClaimId" = NULL,
             "updatedAt" = now()
         WHERE id = $1::uuid
           AND state IN ('reserved', 'cleanup_required')
           AND "resultFileId" IS NULL
         RETURNING id
       )
       SELECT id FROM updated`,
        [operationId],
      );

      if (updated.length !== 1) {
        throw new Error("Copy recovery release was not confirmed");
      }

      // A lost COMMIT acknowledgement must remain an error.
      // The operator must re-inspect the journal; never retry blindly.
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
        } catch {
          // Fail closed: no automatic reconciliation or retry.
        }
      }
      throw error;
    } finally {
      await runner.release();
    }
  });
}
