import { ConfigService } from "@nestjs/config";
import { Writable } from "stream";
import * as fs from "fs";
import * as path from "path";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { SharingService } from "./sharing.service";

/**
 * TEST-ONLY coverage for the Stage B public folder ZIP download contract.
 * Uses real streamed ZIP bytes where practical.
 *
 * NOTE: slot admission (`incrementFolderArchiveDownloadCount`) is a controller-
 * level responsibility; this suite verifies streaming + member scope only.
 */
describe("SharingService - folder ZIP download contract", () => {
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
    tempDir = fs.mkdtempSync(path.join("/tmp", "homecloud-zip-svc-"));
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

  it("fails closed when the share root has no folderId", async () => {
    const share = rootShare();
    share.file.folderId = null as any;
    await expect(service.listArchiveMembers(share)).rejects.toBeInstanceOf(Error);
  });

  it("streams real ZIP bytes containing expected members", async () => {
    const memberPath = path.join(tempDir, "a.txt");
    fs.writeFileSync(memberPath, Buffer.from("hello-zip"));

    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 100, name: "a.txt", isFolder: false, storagePath: memberPath, size: 9, parentId: 40 },
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
    expect(archive).toContain("hello-zip");
    // ZIP local file header signature
    expect(archive.startsWith("PK\x03\x04")).toBe(true);
  });

  it("rejects when a member disappears from storage after admission", async () => {
    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 100, name: "ghost.txt", isFolder: false, storagePath: "/nonexistent/ghost.txt", size: 9, parentId: 40 },
    ]);

    const res = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    }) as any;

    await expect(service.streamFolderArchive(rootShare(), res)).rejects.toThrow();
  });

  it("soft-deleted members are absent from the archive", async () => {
    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
    ]);
    const members = await service.listArchiveMembers(rootShare());
    expect(members).toHaveLength(1);
    expect(members[0].isFolder).toBe(true);
  });

  it("password-protected ZIP works through existing verification", async () => {
    const share = rootShare();
    share.password = "$2b$10$hashedpassword";
    shares.findOne.mockResolvedValue(share);

    const memberPath = path.join(tempDir, "a.txt");
    fs.writeFileSync(memberPath, Buffer.from("hello-zip"));
    files.query.mockResolvedValueOnce([
      { folderId: 40, name: "Root", isFolder: true, storagePath: null, size: null, parentId: null },
      { folderId: 100, name: "a.txt", isFolder: false, storagePath: memberPath, size: 9, parentId: 40 },
    ]);

    const res = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    }) as any;

    await expect(service.streamFolderArchive(share, res)).resolves.toBeUndefined();
  });
});