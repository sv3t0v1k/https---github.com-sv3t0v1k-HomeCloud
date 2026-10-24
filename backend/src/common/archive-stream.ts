import { BadRequestException, NotFoundException } from "@nestjs/common";
import archiver from "archiver";
import * as fs from "fs";
import { Writable } from "stream";
import { StorageService } from "../storage/storage.service";

export interface ArchiveMember {
  logicalPath: string;
  isFolder: boolean;
  storagePath: string | null;
  storageLocationId: string | null;
  relativeObjectKey: string | null;
  size: number;
}

/** Shared ZIP engine for public folders and private selections. File content is streamed one descriptor at a time. */
export async function streamArchiveMembers(
  members: ArchiveMember[],
  storage: StorageService,
  destination: Writable,
  options: {
    pathFor(member: ArchiveMember): string;
    beforeEntry?(member: ArchiveMember): Promise<void>;
    afterOpen?(member: ArchiveMember): Promise<void>;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    enforceMetadataSize?: boolean;
  },
): Promise<void> {
  if (destination.destroyed || destination.writableEnded) return;
  const archive = archiver("zip", { zlib: { level: 0 } });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let activeStream: fs.ReadStream | undefined;
    let pendingFd: number | undefined;
    let streamedBytes = 0;
    const finish = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      if (err || cancelled) {
        activeStream?.destroy();
        if (pendingFd !== undefined) {
          try { fs.closeSync(pendingFd); } catch { /* already closed */ }
          pendingFd = undefined;
        }
        archive.abort();
        archive.unpipe(destination);
      }
      if (err) reject(err);
      else resolve();
    };
    archive.on("error", (err: Error) => finish(err));
    archive.on("end", () => finish());
    archive.pipe(destination);
    destination.on("close", () => { cancelled = true; finish(); });
    destination.on("error", (err: Error) => { cancelled = true; finish(err); });
    if (destination.destroyed || destination.writableEnded) { cancelled = true; finish(); return; }

    const appendEntry = (source: Buffer | fs.ReadStream, data: archiver.EntryData) =>
      new Promise<void>((done, fail) => {
        const clean = () => {
          archive.off("entry", onEntry);
          archive.off("error", onError);
          destination.off("close", onClose);
          destination.off("error", onError);
        };
        const onEntry = () => { clean(); done(); };
        const onClose = () => { clean(); done(); };
        const onError = (err: Error) => { clean(); fail(err); };
        archive.once("entry", onEntry);
        archive.once("error", onError);
        destination.once("close", onClose);
        destination.once("error", onError);
        archive.append(source, data);
      });
    (async () => {
      try {
        for (const member of members) {
          if (cancelled || settled) break;
          if (options.beforeEntry) await options.beforeEntry(member);
          if (cancelled || settled) break;
          const entryName = options.pathFor(member);
          if (member.isFolder) {
            await appendEntry(Buffer.alloc(0), {
              name: member.logicalPath === "" ? "./" : `${entryName}/`,
              type: "directory",
            } as archiver.EntryData);
            continue;
          }
          if (!member.storagePath) throw new BadRequestException("Archive member has no storage path");
          const safePath = storage.resolveFilePath(member);
          const realPath = storage.ensureWithinStorageRoot(fs.realpathSync(safePath));
          const fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          pendingFd = fd;
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new NotFoundException("File not found on storage");
            if (options.enforceMetadataSize && stat.size !== member.size)
              throw new NotFoundException("Archive file changed");
            if (options.maxFileBytes !== undefined && stat.size > options.maxFileBytes)
              throw new BadRequestException("Archive file size limit exceeded");
            streamedBytes += stat.size;
            if (options.maxTotalBytes !== undefined && streamedBytes > options.maxTotalBytes)
              throw new BadRequestException("Archive size limit exceeded");
            if (options.afterOpen) await options.afterOpen(member);
            if (cancelled || settled) break;
            if (stat.size === 0) {
              fs.closeSync(fd);
              pendingFd = undefined;
              await appendEntry(Buffer.alloc(0), { name: entryName, stats: stat });
              continue;
            }
            activeStream = fs.createReadStream(realPath, { fd, autoClose: true, start: 0, end: stat.size - 1 });
            pendingFd = undefined;
            const stream = activeStream;
            activeStream.once("error", (err) => archive.emit("error", err));
            const closed = new Promise<void>((done) => activeStream!.once("close", done));
            await appendEntry(activeStream, { name: entryName, stats: stat });
            await closed;
            if (stream.bytesRead !== stat.size) throw new NotFoundException("Archive file changed during download");
            activeStream = undefined;
          } catch (err) {
            activeStream?.destroy();
            if (pendingFd !== undefined) {
              try { fs.closeSync(pendingFd); } catch { /* already closed */ }
              pendingFd = undefined;
            }
            throw err;
          }
        }
        if (!cancelled && !settled) await archive.finalize();
      } catch (err) { finish(err as Error); }
    })();
  });
}
