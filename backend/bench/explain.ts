import { DataSource } from "typeorm";
import { FixtureResult } from "./fixtures";

/**
 * EXPLAIN (ANALYZE, BUFFERS) support — intentionally opt-in only.
 *
 * This module is NEVER invoked by the default runner. It exists so that
 * Phase 12.2 can collect PostgreSQL query-plan evidence for the accepted
 * hot-path query shapes when the owner explicitly requests it.
 *
 * Calling this requires the same explicit bench env guards as the runner.
 */
export interface ExplainTarget {
  name: string;
  sql: string;
  parameters: unknown[];
}

function hotQueries(userId: number, rootFolderId: number): ExplainTarget[] {
  return [
    {
      name: "files.findAll",
      sql: `SELECT * FROM files WHERE "userId" = $1 AND "isFolder" = false AND "isDeleted" = false AND "parentId" IS NULL ORDER BY "isFolder" DESC, "name" ASC`,
      parameters: [userId],
    },
    {
      name: "files.findFolders",
      sql: `SELECT * FROM folders WHERE "userId" = $1 AND "isDeleted" = false AND "parentId" IS NULL ORDER BY "name" ASC`,
      parameters: [userId],
    },
    {
      name: "files.search.bench",
      sql: `SELECT * FROM files WHERE "userId" = $1 AND "isDeleted" = false AND "name" ILIKE $2 ORDER BY "isFolder" DESC, "name" ASC`,
      parameters: [userId, "%bench%"],
    },
    {
      name: "files.getTrash",
      sql: `SELECT * FROM files WHERE "userId" = $1 AND "isDeleted" = true AND "isFolder" = false ORDER BY "deletedAt" DESC`,
      parameters: [userId],
    },
    {
      name: "uploads.listUploadSessions",
      sql: `SELECT * FROM upload_sessions WHERE "userId" = $1 AND "status" = 'pending' ORDER BY "createdAt" DESC`,
      parameters: [userId],
    },
    {
      name: "sharing.listUserShares",
      sql: `SELECT * FROM share_links WHERE "userId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC`,
      parameters: [userId],
    },
  ];
}

export async function collectExplain(
  dataSource: DataSource,
  fixture: FixtureResult,
): Promise<Record<string, unknown>> {
  const targets = hotQueries(fixture.userId, fixture.rootFolderId);
  const output: Record<string, unknown> = {};

  for (const t of targets) {
    const rows = await dataSource.query(
      `EXPLAIN (ANALYZE, BUFFERS) ${t.sql}`,
      t.parameters,
    );
    output[t.name] = rows;
  }

  return output;
}