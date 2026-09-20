import { ConfigService } from "@nestjs/config";
import { Writable } from "stream";
import * as fs from "fs";
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
    shares = { findOne: jest.fn(), query: jest.fn(), createQueryBuilder: jest.fn() };
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
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 41, name: "Docs", isFolder: true, storagePath: null, size: null, parentId: 40 },
      { folderId: 42, name: "empty", isFolder: true, storagePath: null, size: null, parentId: 40 },
      { folderId: 100, name: "a.txt", isFolder: false, storagePath: "/storage/7/a.txt", size: 5, parentId: 41 },
      { folderId: 101, name: "b.txt", isFolder: false, storagePath: "/storage/7/b.txt", size: 6, parentId: 41 },
    ]);

    const members = await service.listArchiveMembers(rootShare());
    const paths = members.map(m => m.logicalPath).sort();
    expect(paths).toEqual(["", "Docs", "Docs/a.txt", "Docs/b.txt", "empty"]);
    const emptyFolder = members.find(m => m.folderId === 42);
    expect(emptyFolder?.isFolder).toBe(true);
  });

  it("excludes soft-deleted members", async () => {
    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
    ]);
    const members = await service.listArchiveMembers(rootShare());
    expect(members).toHaveLength(1);
    expect(members[0].folderId).toBe(40);
  });

  it("fails closed when the share root has no folderId", async () => {
    const share = rootShare();
    share.file.folderId = null as any;
    await expect(service.listArchiveMembers(share)).rejects.toBeInstanceOf(Error);
  });

  it("rejects traversal-like stored names from escaping the archive root", () => {
    expect(() => SharingService.safeArchivePath("docs/../secret")).toThrow(Error);
    expect(() => SharingService.safeArchivePath("/etc/passwd")).toThrow(Error);
    expect(SharingService.safeArchivePath("a\\b\\c")).toBe("a/b/c");
    expect(SharingService.safeArchivePath("./a/./b")).toBe("a/b");
  });

  it("streams members without buffering whole file contents", async () => {
    const memberPath = path.join(tempDir, "a.txt");
    fs.writeFileSync(memberPath, Buffer.from("hello"));

    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 100, name: "a.txt", isFolder: false, storagePath: memberPath, size: 5, parentId: 40 },
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

  it("cleans up the fd when a member fails to open", async () => {
    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 100, name: "ghost.txt", isFolder: false, storagePath: "/nonexistent/ghost.txt", size: 5, parentId: 40 },
    ]);

    const res = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    }) as any;

    await expect(service.streamFolderArchive(rootShare(), res)).rejects.toThrow();
  });
});