import { NotFoundException } from "@nestjs/common";

export async function assertVisibleAncestors(
  manager: import("typeorm").EntityManager,
  userId: number,
  parentId: number | null,
): Promise<void> {
  if (parentId === null) return;
  if (!Number.isSafeInteger(parentId) || parentId <= 0) {
    throw new NotFoundException("File not found");
  }

  const rows: Array<{ visible: boolean }> = await manager.query(
    `
    WITH RECURSIVE ancestor_chain AS (
      SELECT folder.id, folder."parentId", folder."isDeleted",
             ARRAY[folder.id]::integer[] AS visited,
             FALSE AS cycle
      FROM folders folder
      WHERE folder.id = $2 AND folder."userId" = $1

      UNION ALL

      SELECT parent.id, parent."parentId", parent."isDeleted",
             chain.visited || parent.id,
             parent.id = ANY(chain.visited)
      FROM folders parent
      JOIN ancestor_chain chain ON parent.id = chain."parentId"
      WHERE parent."userId" = $1
        AND NOT chain.cycle
        AND cardinality(chain.visited) < 256
    )
    SELECT (
      COALESCE(bool_and(
        NOT chain."isDeleted"
        AND NOT chain.cycle
        AND EXISTS (
          SELECT 1 FROM files mirror
          WHERE mirror."folderId" = chain.id
            AND mirror."userId" = $1
            AND mirror."isFolder"
            AND NOT mirror."isDeleted"
            AND mirror."parentId"
                IS NOT DISTINCT FROM chain."parentId"
        )
      ), FALSE)
      AND COALESCE(bool_or(chain."parentId" IS NULL), FALSE)
    ) AS visible
    FROM ancestor_chain chain
    `,
    [userId, parentId],
  );

  if (rows.length !== 1 || rows[0].visible !== true) {
    throw new NotFoundException("File not found");
  }
}
