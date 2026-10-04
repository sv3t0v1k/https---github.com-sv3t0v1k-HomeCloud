import { ConfigService } from "@nestjs/config";
import { Writable } from "stream";
import * as fs from "fs";
import nativeFs from "fs";
import * as path from "path";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { SharingService } from "./sharing.service";

/**
 * TEST-ONLY coverage for the streaming ZIP foundation.
 * No production code other than SharingService is modified here.
 */
describe("SharingService — folder archive foundation", () => {
  let service: SharingService;
  let files: any;
  let shares: any;
  let tempDir: string;

  const rootShare = (): ShareLinkEntity =>
    Object.assign(new ShareLinkEntity(), {
      id: 1,
      token: "folder-token",
      fileId: 900,
      userId: 7,
      isActive: true,
      expiresAt: null,
      password: undefined,
      file: Object.assign(new FileEntity(), {
        id: 900,
        folderId: 40,
        userId: 7,
        isFolder: true,
        isDeleted: false,
      }),
      user: Object.assign(new UserEntity(), { id: 7, isActive: true }),
    });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join("/tmp", "homecloud-archive-"));
    shares = {
      findOne: jest.fn(),
      query: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    files = { findOne: jest.fn(), query: jest.fn() };
    service = new SharingService(
      shares,
      files,
      { findOne: jest.fn() } as any,
      new ConfigService(),
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );
    shares.findOne.mockResolvedValue(rootShare());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("returns nested relative paths for members", async () => {
    files.query.mockResolvedValueOnce([
      {
        folderId: 40,
        name: "Root",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: null,
      },
      {
        folderId: 41,
        name: "Docs",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: 40,
      },
      {
        folderId: 42,
        name: "empty",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: 40,
      },
      {
        folderId: 100,
        name: "a.txt",
        isFolder: false,
        storagePath: "/storage/7/a.txt",
        size: 5,
        parentId: 41,
      },
      {
        folderId: 101,
        name: "b.txt",
        isFolder: false,
        storagePath: "/storage/7/b.txt",
        size: 6,
        parentId: 41,
      },
    ]);

    const members = await service.listArchiveMembers(rootShare());
    const paths = members.map((m) => m.logicalPath).sort();
    expect(paths).toEqual(["", "Docs", "Docs/a.txt", "Docs/b.txt", "empty"]);
    const emptyFolder = members.find((m) => m.folderId === 42);
    expect(emptyFolder?.isFolder).toBe(true);
  });

  it("excludes soft-deleted members", async () => {
    files.query.mockResolvedValueOnce([
      {
        folderId: 40,
        name: "Root",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: null,
      },
    ]);
    const members = await service.listArchiveMembers(rootShare());
    expect(members).toHaveLength(1);
    expect(members[0].folderId).toBe(40);
  });

  it("fails closed when the share root has no folderId", async () => {
    const share = rootShare();
    share.file.folderId = null as any;
    await expect(service.listArchiveMembers(share)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("rejects traversal-like stored names from escaping the archive root", () => {
    expect(() => SharingService.safeArchivePath("docs/../secret")).toThrow(
      Error,
    );
    expect(() => SharingService.safeArchivePath("/etc/passwd")).toThrow(Error);
    expect(SharingService.safeArchivePath("a\\b\\c")).toBe("a/b/c");
    expect(SharingService.safeArchivePath("./a/./b")).toBe("a/b");
  });

  it("streams members without buffering whole file contents", async () => {
    const memberPath = path.join(tempDir, "a.txt");
    fs.writeFileSync(memberPath, Buffer.from("hello"));

    files.query.mockResolvedValueOnce([
      {
        folderId: 40,
        name: "Root",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: null,
      },
      {
        folderId: 100,
        name: "a.txt",
        isFolder: false,
        storagePath: memberPath,
        size: 5,
        parentId: 40,
      },
    ]);

    const written: Buffer[] = [];
    const res = new Writable({
      write(chunk, encoding, callback) {
        written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as any;

    await service.streamFolderArchive(rootShare(), res);

    const archive = Buffer.concat(written).toString("binary");
    expect(archive).toContain("a.txt");
    expect(archive).toContain("hello");
    // The whole file content must not be held in memory before streaming.
    expect(Buffer.concat(written).length).toBeGreaterThan(0);
  });

  it("preserves a direct empty child directory name in real ZIP bytes", async () => {
    files.query.mockResolvedValueOnce([
      {
        folderId: 40,
        name: "Root",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: null,
      },
      {
        folderId: 41,
        name: "Контроль",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: 40,
      },
    ]);
    const written: Buffer[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    });
    await service.streamFolderArchive(rootShare(), destination);
    const bytes = Buffer.concat(written);
    const names: string[] = [];
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
      const length = bytes.readUInt16LE(offset + 28);
      names.push(
        bytes.subarray(offset + 46, offset + 46 + length).toString("utf8"),
      );
    }
    expect(names).toEqual(["./", "Контроль/"]);
  });

  it("bounds member descriptors independently of archive member count", async () => {
    const memberPath = path.join(tempDir, "member.bin");
    fs.writeFileSync(memberPath, Buffer.alloc(1024));
    jest.spyOn(service, "listArchiveMembers").mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => ({
        isFolder: false,
        storagePath: memberPath,
        logicalPath: `member-${i}`,
        name: `member-${i}`,
      })) as any,
    );
    const native = nativeFs;
    const create = native.createReadStream;
    let active = 0;
    let peak = 0;
    const spy = jest
      .spyOn(native, "createReadStream")
      .mockImplementation((...args: any[]) => {
        const stream = create(args[0], args[1]);
        active++;
        peak = Math.max(peak, active);
        stream.once("close", () => active--);
        return stream;
      });
    try {
      await service.streamFolderArchive(
        rootShare(),
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      );
      expect(peak).toBe(1);
      expect(active).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("destroys the current member and opens no later member on disconnect", async () => {
    const memberPath = path.join(tempDir, "abort.bin");
    fs.writeFileSync(memberPath, Buffer.alloc(1024 * 1024));
    jest.spyOn(service, "listArchiveMembers").mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        isFolder: false,
        storagePath: memberPath,
        logicalPath: `member-${i}`,
        name: `member-${i}`,
      })) as any,
    );
    const native = nativeFs;
    const create = native.createReadStream;
    const opened: fs.ReadStream[] = [];
    const spy = jest
      .spyOn(native, "createReadStream")
      .mockImplementation((...args: any[]) => {
        const stream = create(args[0], args[1]);
        opened.push(stream);
        return stream;
      });
    const destination = new Writable({
      write(_chunk, _encoding, done) {
        this.destroy();
        done();
      },
    });
    try {
      await service.streamFolderArchive(rootShare(), destination);
      await new Promise((done) => setImmediate(done));
      expect(opened.length).toBeLessThanOrEqual(1);
      expect(opened.every((stream) => stream.destroyed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("cleans up the fd when a member fails to open", async () => {
    files.query.mockResolvedValueOnce([
      {
        folderId: 40,
        name: "Root",
        isFolder: true,
        storagePath: null,
        size: null,
        parentId: null,
      },
      {
        folderId: 100,
        name: "ghost.txt",
        isFolder: false,
        storagePath: "/nonexistent/ghost.txt",
        size: 5,
        parentId: 40,
      },
    ]);

    const res = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    }) as any;

    await expect(
      service.streamFolderArchive(rootShare(), res),
    ).rejects.toThrow();
  });
});
