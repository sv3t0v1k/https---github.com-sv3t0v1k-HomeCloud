import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileEntity } from "../entities/file.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UserEntity } from "../entities/user.entity";
import { SharingService } from "./sharing.service";

describe("SharingService — scoped folder sharing", () => {
  let service: SharingService;
  let shares: any;
  let files: any;

  const folderShare = (): ShareLinkEntity => Object.assign(new ShareLinkEntity(), {
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
    shares = { findOne: jest.fn(), query: jest.fn(), createQueryBuilder: jest.fn() };
    files = { findOne: jest.fn(), query: jest.fn() };
    service = new SharingService(shares, files, { findOne: jest.fn() } as any, new ConfigService());
    shares.findOne.mockResolvedValue(folderShare());
  });

  it("lists only fields returned by the scoped children query and paginates", async () => {
    files.query.mockResolvedValueOnce([
      { id: 41, name: "Docs", kind: "folder", size: null, mimeType: null, __parentAllowed: 40 },
      { id: 51, name: "a.txt", kind: "file", size: "5", mimeType: "text/plain", __parentAllowed: 40 },
      { id: 52, name: "b.txt", kind: "file", size: "6", mimeType: "text/plain", __parentAllowed: 40 },
    ]);

    await expect(service.listSharedChildren("folder-token", { limit: 2, offset: 0 })).resolves.toEqual({
      parentId: 40,
      items: [
        { id: 41, name: "Docs", kind: "folder", size: null, mimeType: null },
        { id: 51, name: "a.txt", kind: "file", size: "5", mimeType: "text/plain" },
      ],
      limit: 2,
      offset: 0,
      hasMore: true,
    });
    expect(files.query.mock.calls[0][1]).toEqual([40, 7, 40, 3, 0, "folder-token"]);
  });

  it("fails closed for a same-owner folder outside the shared subtree", async () => {
    files.query.mockResolvedValueOnce([]);
    await expect(
      service.listSharedChildren("folder-token", { parentId: 99, limit: 50, offset: 0 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects children listing for an ordinary file share", async () => {
    const share = folderShare();
    share.file.isFolder = false;
    share.file.folderId = null;
    shares.findOne.mockResolvedValue(share);
    await expect(service.listSharedChildren("folder-token", { limit: 50, offset: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an oversized password header before bcrypt", async () => {
    const share = folderShare();
    share.password = "hash";
    shares.findOne.mockResolvedValue(share);
    await expect(
      service.listSharedChildren("folder-token", { limit: 50, offset: 0 }, "x".repeat(1025)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(files.query).not.toHaveBeenCalled();
  });

  it("resolves a file only when the recursive subtree query confirms scope", async () => {
    const file = Object.assign(new FileEntity(), { id: 51, userId: 7, isDeleted: false, isFolder: false });
    files.findOne.mockResolvedValue(file);
    files.query.mockResolvedValue([{ ok: 1 }]);
    await expect(service.resolveSharedFolderFile(folderShare(), 51)).resolves.toBe(file);
    expect(files.findOne).toHaveBeenCalledWith({
      where: { id: 51, userId: 7, isDeleted: false, isFolder: false },
    });
  });

  it("rejects an existing same-owner sibling outside the subtree", async () => {
    files.findOne.mockResolvedValue({ id: 51, userId: 7, isDeleted: false, isFolder: false });
    files.query.mockResolvedValue([]);
    await expect(service.resolveSharedFolderFile(folderShare(), 51))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("atomically admits only a still-scoped descendant and returns the shared counter", async () => {
    shares.query.mockResolvedValue([{ downloadCount: "3" }]);
    await expect(service.incrementFolderDownloadCount("folder-token", 51))
      .resolves.toEqual({ downloadCount: "3" });
    expect(shares.query.mock.calls[0][0]).toContain("EXISTS (SELECT 1 FROM allowed)");
    expect(shares.query.mock.calls[0][1]).toEqual(["folder-token", 51]);
  });

  it("does not consume a slot when target is no longer in scope", async () => {
    shares.query.mockResolvedValue([]);
    await expect(service.incrementFolderDownloadCount("folder-token", 51))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
