import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { createHash, randomBytes } from "crypto";

export const DOWNLOAD_CAPABILITY_TTL_MS = 120_000;
export const DOWNLOAD_CAPABILITY_COOKIE = "hc_native_download";
export const downloadCookiePath = (fileId: number) =>
  `/api/v1/native-downloads/${fileId}`;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class DownloadCapabilityService {
  constructor(private readonly dataSource: DataSource) {}

  async issue(userId: number, fileId: number): Promise<string> {
    const token = randomBytes(32).toString("hex");
    await this.dataSource.transaction(async (manager) => {
      // Bound issuance across replicas, not merely in one JavaScript process.
      await manager.query("SELECT pg_advisory_xact_lock(1746825140)");
      await manager.query(
        `DELETE FROM "download_capabilities" WHERE "expiresAt" <= NOW()`,
      );
      await manager.query(
        `DELETE FROM "download_capabilities" WHERE "userId" = $1 AND "fileId" = $2`,
        [userId, fileId],
      );
      const [counts] = await manager.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "userId" = $1)::int AS own FROM "download_capabilities"`,
        [userId],
      );
      if (counts.total >= 10000 || counts.own >= 8) {
        throw new HttpException(
          "Too many pending downloads",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await manager.query(
        `INSERT INTO "download_capabilities" ("tokenHash", "userId", "fileId", "expiresAt") VALUES ($1, $2, $3, NOW() + INTERVAL '120 seconds')`,
        [hash(token), userId, fileId],
      );
    });
    return token;
  }

  async authorize(
    token: string | undefined,
    fileId: number,
    consume: boolean,
  ): Promise<number> {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new NotFoundException("Download unavailable");
    // Revalidate the actual owner, active account and undeleted resource at use.
    // DELETE...RETURNING makes concurrent replay admission atomic.
    const scope = `c."tokenHash" = $1 AND c."fileId" = $2 AND c."expiresAt" > NOW()
      AND EXISTS (
        SELECT 1 FROM "users" u
        JOIN "files" f ON f."userId" = u.id
        WHERE u.id = c."userId"
          AND u."isActive" = TRUE
          AND f.id = c."fileId"
          AND f."isDeleted" = FALSE
          AND f."isFolder" = FALSE
          AND (
            f."parentId" IS NULL
            OR (
              WITH RECURSIVE ancestor_chain AS (
                SELECT folder.id, folder."parentId", folder."isDeleted",
                       ARRAY[folder.id]::integer[] AS visited,
                       FALSE AS cycle
                FROM folders folder
                WHERE folder.id = f."parentId"
                  AND folder."userId" = c."userId"

                UNION ALL

                SELECT parent.id, parent."parentId", parent."isDeleted",
                       chain.visited || parent.id,
                       parent.id = ANY(chain.visited)
                FROM folders parent
                JOIN ancestor_chain chain
                  ON parent.id = chain."parentId"
                WHERE parent."userId" = c."userId"
                  AND NOT chain.cycle
                  AND cardinality(chain.visited) < 256
              )
              SELECT
                COALESCE(bool_and(
                  NOT chain."isDeleted"
                  AND NOT chain.cycle
                  AND EXISTS (
                    SELECT 1 FROM files mirror
                    WHERE mirror."folderId" = chain.id
                      AND mirror."userId" = c."userId"
                      AND mirror."isFolder"
                      AND NOT mirror."isDeleted"
                      AND mirror."parentId"
                          IS NOT DISTINCT FROM chain."parentId"
                  )
                ), FALSE)
                AND COALESCE(
                  bool_or(chain."parentId" IS NULL),
                  FALSE
                )
              FROM ancestor_chain chain
            )
          )
      )`;
    const rows = await this.dataSource.query(
      consume
        ? `DELETE FROM "download_capabilities" c WHERE ${scope} RETURNING c."userId"`
        : `SELECT c."userId" FROM "download_capabilities" c WHERE ${scope}`,
      [hash(token), fileId],
    );
    // pg DELETE can return [rows, affectedCount] via TypeORM's raw query API.
    const result = Array.isArray(rows[0]) ? rows[0] : rows;
    if (result.length !== 1)
      throw new NotFoundException("Download unavailable");
    return Number(result[0].userId);
  }
}
