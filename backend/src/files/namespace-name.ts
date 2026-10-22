import { NotFoundException, ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";

/** Lock the destination before examining the shared live file/folder namespace. */
export async function allocateNamespaceName(
  manager: EntityManager,
  userId: number,
  parentId: number | null | undefined,
  requested: string,
  kind: "file" | "folder",
): Promise<string> {
  if (parentId != null) {
    const [parent] = await manager.query(
      `SELECT id FROM folders WHERE id=$1 AND "userId"=$2 AND NOT "isDeleted" FOR UPDATE`,
      [parentId, userId],
    );
    if (!parent) throw new NotFoundException("Destination folder unavailable");
  }
  const names: { name: string }[] = await manager.query(
    `SELECT name FROM files WHERE "userId"=$1 AND "parentId" IS NOT DISTINCT FROM $2
       AND NOT "isDeleted"
     UNION SELECT name FROM folders WHERE "userId"=$1 AND "parentId" IS NOT DISTINCT FROM $2
       AND NOT "isDeleted"`,
    [userId, parentId ?? null],
  );
  const occupied = new Set(names.map((row) => row.name));
  if (!occupied.has(requested)) return requested;
  const dot = kind === "file" ? requested.lastIndexOf(".") : -1;
  const extension = dot > 0 ? requested.slice(dot) : "";
  const stem = extension ? requested.slice(0, dot) : requested;
  for (let index = 1; index <= 10000; index++) {
    const suffix = ` (${index})`;
    const suffixBudget = 255 - suffix.length;
    const safeExtension = extension.slice(0, Math.max(0, suffixBudget - 1));
    const candidate =
      stem.slice(0, suffixBudget - safeExtension.length) + suffix + safeExtension;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new ConflictException("Destination name space exhausted");
}
