import {
  BadRequestException, ConflictException, HttpException, HttpStatus,
  Injectable, NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import { Writable } from "stream";
import { isDeepStrictEqual } from "util";
import { DataSource } from "typeorm";
import { parseDatabaseSize } from "../common/database-size";
import { ArchiveMember, streamArchiveMembers } from "../common/archive-stream";
import { StorageService } from "../storage/storage.service";

export type ArchiveSelection = { kind: "file" | "folder"; id: number };
interface Member extends ArchiveMember {
  kind: "file" | "folder";
  id: number;
  parentId: number | null;
  name: string;
}
interface Manifest { roots: ArchiveSelection[]; members: Member[] }
interface FolderRow { id: number; parentId: number | null; name: string; userId: number; isDeleted: boolean; depth: number; mirrorId: number | null }
interface FileRow { id: number; parentId: number | null; name: string; userId: number; isDeleted: boolean; isFolder: boolean; size: string | number; storagePath: string | null; storageLocationId: string | null; relativeObjectKey: string | null }

const MAX_ROOTS = 32;
const MAX_MEMBERS = 5000;
const MAX_DEPTH = 32;
const MAX_BYTES = 100 * 1024 ** 3;
const MAX_FILE_BYTES = 100 * 1024 ** 3;
export const ARCHIVE_COOKIE = "hc_archive_download";
export const archiveCookiePath = (id: string) => `/api/v1/native-download-archives/${id}`;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

@Injectable()
export class ArchiveDownloadsService {
  private static activeStreams = 0;
  private static activePrepares = 0;
  constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

  async prepare(userId: number, input: unknown): Promise<{ id: string; token: string }> {
    const roots = this.parseSelection(input);
    if (ArchiveDownloadsService.activePrepares >= 2)
      throw new HttpException("Archive preparation is busy", HttpStatus.TOO_MANY_REQUESTS);
    ArchiveDownloadsService.activePrepares++;
    try {
      const manifest = await this.plan(userId, roots);
      await this.preflight(manifest);
      const id = randomBytes(16).toString("hex");
      const token = randomBytes(32).toString("hex");
      await this.db.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(1746825141)");
      await manager.query(`DELETE FROM archive_download_capabilities WHERE "expiresAt" <= NOW()`);
      const [counts] = await manager.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "userId" = $1)::int AS own FROM archive_download_capabilities`, [userId],
      );
      if (counts.total >= 1000 || counts.own >= 2)
        throw new HttpException("Too many pending archives", HttpStatus.TOO_MANY_REQUESTS);
      await manager.query(
        `INSERT INTO archive_download_capabilities (id, "tokenHash", "userId", manifest, "expiresAt") VALUES ($1, $2, $3, $4::jsonb, NOW() + INTERVAL '120 seconds')`,
        [id, tokenHash(token), userId, JSON.stringify(manifest)],
      );
      });
      return { id, token };
    } finally { ArchiveDownloadsService.activePrepares--; }
  }

  async authorize(id: string, token: string | undefined, consume: boolean): Promise<{ userId: number; manifest: Manifest }> {
    if (!/^[a-f0-9]{32}$/.test(id) || !token || !/^[a-f0-9]{64}$/.test(token))
      throw new NotFoundException("Archive unavailable");
    const scope = `c.id = $1 AND c."tokenHash" = $2 AND c."expiresAt" > NOW()
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = c."userId" AND u."isActive" = true)`;
    const rows = await this.db.query(
      consume ? `DELETE FROM archive_download_capabilities c
       WHERE ${scope} RETURNING c."userId", c.manifest` :
        `SELECT c."userId", c.manifest FROM archive_download_capabilities c WHERE ${scope}`,
      [id, tokenHash(token)],
    );
    const result = Array.isArray(rows[0]) ? rows[0] : rows;
    if (result.length !== 1) throw new NotFoundException("Archive unavailable");
    return { userId: Number(result[0].userId), manifest: result[0].manifest as Manifest };
  }

  async stream(userId: number, original: Manifest, destination: Writable): Promise<void> {
    if (ArchiveDownloadsService.activeStreams >= 2)
      throw new HttpException("Archive server is busy", HttpStatus.TOO_MANY_REQUESTS);
    ArchiveDownloadsService.activeStreams++;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    destination.once("close", onClose);
    try {
      if (destination.destroyed || destination.writableEnded) return;
      const current = await this.plan(userId, original.roots, abort.signal);
      if (destination.destroyed || destination.writableEnded) return;
      if (!isDeepStrictEqual(current, original))
        throw new ConflictException("Archive contents changed; prepare it again");
      await this.preflight(current, abort.signal);
      if (destination.destroyed || destination.writableEnded) return;
      await streamArchiveMembers(current.members, this.storage, destination, {
        pathFor: (member) => member.logicalPath,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_BYTES,
        enforceMetadataSize: true,
        beforeEntry: async (member) => this.revalidateEntry(userId, member as Member),
        afterOpen: async (member) => this.revalidateEntry(userId, member as Member),
      });
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      destination.off("close", onClose);
      ArchiveDownloadsService.activeStreams--;
    }
  }

  private parseSelection(input: unknown): ArchiveSelection[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROOTS)
      throw new BadRequestException("Select 1 to 32 files or folders");
    const seen = new Set<string>();
    return input.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Invalid archive selection");
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).sort().join(",") !== "id,kind" ||
        (entry.kind !== "file" && entry.kind !== "folder") ||
        !Number.isSafeInteger(entry.id) || Number(entry.id) < 1 || Number(entry.id) > 2147483647)
        throw new BadRequestException("Invalid archive selection");
      const root = { kind: entry.kind, id: Number(entry.id) } as ArchiveSelection;
      const key = `${root.kind}:${root.id}`;
      if (seen.has(key)) throw new BadRequestException("Duplicate archive selection");
      seen.add(key);
      return root;
    });
  }

  private async plan(userId: number, roots: ArchiveSelection[], signal?: AbortSignal): Promise<Manifest> {
    // Sort folder roots by ancestry depth, so a selected ancestor always absorbs selected descendants.
    const folderRoots: { root: ArchiveSelection; row: FolderRow; depth: number }[] = [];
    const fileRoots: { root: ArchiveSelection; row: FileRow }[] = [];
    for (const root of roots) {
      this.checkAbort(signal);
      if (root.kind === "folder") {
        const ancestors = await this.ancestors(userId, root.id);
        this.checkAbort(signal);
        folderRoots.push({ root, row: ancestors[0], depth: ancestors.length });
      } else {
        const row = await this.file(userId, root.id);
        this.checkAbort(signal);
        if (row.parentId !== null) await this.ancestors(userId, row.parentId);
        this.checkAbort(signal);
        fileRoots.push({ root, row });
      }
    }
    folderRoots.sort((a, b) => a.depth - b.depth || a.root.id - b.root.id);
    fileRoots.sort((a, b) => a.root.id - b.root.id);
    const members: Member[] = [];
    const seen = new Set<string>();
    const topNames = new Set<string>();
    for (const { root, row } of folderRoots) {
      this.checkAbort(signal);
      if (seen.has(`folder:${root.id}`)) continue;
      const topName = this.reserveRootName(row.name, topNames);
      const { folders, files } = await this.folderTree(userId, root.id);
      this.checkAbort(signal);
      const paths = new Map<number, string>();
      for (const folder of folders) {
        this.checkAbort(signal);
        const parent = folder.id === root.id ? "" : paths.get(folder.parentId!);
        if (parent === undefined) throw new ConflictException("Folder tree changed");
        const logicalPath = folder.id === root.id ? topName : `${parent}/${this.segment(folder.name)}`;
        paths.set(folder.id, logicalPath);
        this.add(members, seen, { kind: "folder", id: folder.id, parentId: folder.parentId, name: folder.name,
          logicalPath, isFolder: true, storagePath: null, storageLocationId: null, relativeObjectKey: null, size: 0 });
      }
      for (const file of files) {
        this.checkAbort(signal);
        const parent = paths.get(file.parentId!);
        if (!parent) throw new ConflictException("Folder tree changed");
        this.add(members, seen, this.member(file, `${parent}/${this.segment(file.name)}`));
      }
    }
    for (const { row } of fileRoots) {
      this.checkAbort(signal);
      if (seen.has(`file:${row.id}`)) continue;
      const name = this.reserveRootName(row.name, topNames);
      this.add(members, seen, this.member(row, name));
    }
    this.validateManifest(members);
    return { roots, members };
  }

  private async ancestors(userId: number, id: number): Promise<FolderRow[]> {
    const rows: FolderRow[] = await this.db.query(
      `WITH RECURSIVE chain AS (
        SELECT f.id, f."parentId", f.name, f."userId", f."isDeleted", 0 AS depth, ARRAY[f.id] AS visited
        FROM folders f WHERE f.id = $1
        UNION ALL
        SELECT f.id, f."parentId", f.name, f."userId", f."isDeleted", c.depth + 1, c.visited || f.id
        FROM folders f JOIN chain c ON f.id = c."parentId"
        WHERE c.depth < $3 AND NOT f.id = ANY(c.visited)
      )
      SELECT c.*, m.id AS "mirrorId" FROM chain c
      LEFT JOIN files m ON m."folderId" = c.id AND m."userId" = $2 AND m."isFolder" = true AND m."isDeleted" = false
      ORDER BY c.depth`, [id, userId, MAX_DEPTH + 1],
    );
    if (!rows.length || rows.length > MAX_DEPTH + 1 || rows[rows.length - 1].parentId !== null ||
      rows.some((row) => Number(row.userId) !== userId || row.isDeleted || row.mirrorId === null))
      throw new NotFoundException("Folder unavailable");
    return rows;
  }

  private async file(userId: number, id: number): Promise<FileRow> {
    const rows: FileRow[] = await this.db.query(
      `SELECT id, "parentId", name, "userId", "isDeleted", "isFolder", size,
        "storagePath", "storageLocationId", "relativeObjectKey"
       FROM files WHERE id = $1 AND "userId" = $2`, [id, userId],
    );
    const row = rows[0];
    if (!row || row.isDeleted || row.isFolder || !row.storagePath)
      throw new NotFoundException("File unavailable");
    return row;
  }

  private async folderTree(userId: number, rootId: number): Promise<{ folders: FolderRow[]; files: FileRow[] }> {
    const folders: FolderRow[] = await this.db.query(
      `WITH RECURSIVE tree AS (
        SELECT f.id, f."parentId", f.name, f."userId", f."isDeleted", 0 AS depth, ARRAY[f.id] AS visited
        FROM folders f WHERE f.id = $1 AND f."userId" = $2 AND f."isDeleted" = false
        UNION ALL
        SELECT f.id, f."parentId", f.name, f."userId", f."isDeleted", t.depth + 1, t.visited || f.id
        FROM folders f JOIN tree t ON f."parentId" = t.id
        WHERE f."userId" = $2 AND f."isDeleted" = false AND t.depth <= $3
          AND NOT f.id = ANY(t.visited)
      )
      SELECT t.id, t."parentId", t.name, t."userId", t."isDeleted", t.depth, m.id AS "mirrorId"
      FROM tree t LEFT JOIN files m ON m."folderId" = t.id AND m."userId" = $2 AND m."isFolder" = true AND m."isDeleted" = false
      LIMIT $4`, [rootId, userId, MAX_DEPTH, MAX_MEMBERS + 1],
    );
    if (!folders.length || folders.length > MAX_MEMBERS || folders.some((f) => f.depth > MAX_DEPTH || f.mirrorId === null))
      throw new BadRequestException("Archive folder limit exceeded or unavailable");
    folders.sort((a, b) => a.depth - b.depth || a.id - b.id);
    const ids = folders.map((row) => row.id);
    const files: FileRow[] = await this.db.query(
      `SELECT id, "parentId", name, "userId", "isDeleted", "isFolder", size,
        "storagePath", "storageLocationId", "relativeObjectKey"
       FROM files WHERE "parentId" = ANY($1::integer[]) AND "userId" = $2
         AND "isDeleted" = false AND "isFolder" = false LIMIT $3`,
      [ids, userId, MAX_MEMBERS + 1],
    );
    if (files.length > MAX_MEMBERS) throw new BadRequestException("Archive member limit exceeded");
    files.sort((a, b) => a.id - b.id);
    return { folders, files };
  }

  private member(row: FileRow, logicalPath: string): Member {
    return { kind: "file", id: Number(row.id), parentId: row.parentId, name: row.name,
      logicalPath, isFolder: false, storagePath: row.storagePath,
      storageLocationId: row.storageLocationId, relativeObjectKey: row.relativeObjectKey,
      size: parseDatabaseSize(row.size, "Invalid file size metadata") };
  }

  private add(members: Member[], seen: Set<string>, member: Member) {
    const key = `${member.kind}:${member.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    members.push(member);
    if (members.length > MAX_MEMBERS) throw new BadRequestException("Archive member limit exceeded");
  }

  private segment(name: string): string {
    const normalized = name.normalize("NFC");
    if (!normalized || normalized.length > 255 || normalized === "." || normalized === ".." ||
      // eslint-disable-next-line no-control-regex
      /[\\/:*?"<>|\x00-\x1f\x7f]/u.test(normalized) || /[. ]$/u.test(normalized) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized))
      throw new BadRequestException("Unsafe archive name");
    return normalized;
  }

  private reserveRootName(raw: string, names: Set<string>): string {
    const name = this.segment(raw);
    let candidate = name;
    for (let suffix = 2; names.has(candidate.toLocaleLowerCase("und")); suffix++) {
      if (suffix > MAX_ROOTS + 1) throw new ConflictException("Archive name collision");
      candidate = this.segment(`${name} (${suffix})`);
    }
    names.add(candidate.toLocaleLowerCase("und"));
    return candidate;
  }

  private validateManifest(members: Member[]) {
    if (!members.length) throw new BadRequestException("Archive is empty");
    const paths = new Set<string>();
    let bytes = 0;
    for (const member of members) {
      if (member.logicalPath.length > 1024 || member.logicalPath.split("/").length > MAX_DEPTH + 1)
        throw new BadRequestException("Archive path limit exceeded");
      const key = member.logicalPath.normalize("NFC").toLocaleLowerCase("und");
      if (paths.has(key)) throw new ConflictException("Archive names collide");
      paths.add(key);
      if (!member.isFolder) {
        if (!Number.isSafeInteger(member.size) || member.size < 0 || member.size > MAX_FILE_BYTES)
          throw new BadRequestException("Archive file size limit exceeded");
        bytes += member.size;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES)
          throw new BadRequestException("Archive size limit exceeded");
      }
    }
  }

  private async preflight(manifest: Manifest, signal?: AbortSignal) {
    for (const member of manifest.members) {
      this.checkAbort(signal);
      if (member.isFolder) continue;
      try {
        const safePath = this.storage.resolveFilePath(member);
        const real = this.storage.ensureWithinStorageRoot(await fs.promises.realpath(safePath));
        this.checkAbort(signal);
        const fd = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = await fd.stat();
          this.checkAbort(signal);
          if (!stat.isFile() || stat.size !== member.size) throw new NotFoundException("Archive file changed");
        } finally { await fd.close(); }
      } catch { throw new NotFoundException("Archive file unavailable"); }
    }
  }

  private checkAbort(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Archive transfer cancelled");
  }

  private async revalidateEntry(userId: number, member: Member) {
    if (member.kind === "folder") {
      const current = (await this.ancestors(userId, member.id))[0];
      if (current.name !== member.name || current.parentId !== member.parentId)
        throw new ConflictException("Archive folder changed");
      return;
    }
    const current = await this.file(userId, member.id);
    if (current.parentId !== member.parentId || current.name !== member.name ||
      current.storagePath !== member.storagePath ||
      current.storageLocationId !== member.storageLocationId ||
      current.relativeObjectKey !== member.relativeObjectKey ||
      parseDatabaseSize(current.size, "Invalid file size metadata") !== member.size)
      throw new ConflictException("Archive file changed");
    if (current.parentId !== null) await this.ancestors(userId, current.parentId);
  }
}
