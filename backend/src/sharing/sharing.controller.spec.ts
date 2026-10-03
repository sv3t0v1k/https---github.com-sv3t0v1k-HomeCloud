import { NotFoundException, BadRequestException } from "@nestjs/common";
import { SharingController } from "./sharing.controller";
import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";

describe("SharingController - streaming code verification", () => {
  it("streams a ZIP archive for a folder share without fileId and consumes one slot", async () => {
    const mockService = {
      findShareByToken: jest.fn(),
      verifySharePassword: jest.fn(),
      listArchiveMembers: jest.fn(),
      streamFolderArchive: jest.fn(),
      incrementFolderArchiveDownloadCount: jest.fn(),
      incrementDownloadCount: jest.fn(),
    };

    mockService.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: {
        id: 1,
        name: "MyFolder",
        mimeType: "application/zip",
        size: 0,
        isFolder: true,
        folderId: 40,
        storagePath: null,
      },
    });
    mockService.listArchiveMembers.mockResolvedValue([
      { folderId: 40, name: "MyFolder", logicalPath: "", isFolder: true, storagePath: null, size: 0 },
    ]);
    mockService.incrementFolderArchiveDownloadCount.mockResolvedValue({ downloadCount: 1 });
    mockService.streamFolderArchive.mockImplementation(async (_share: any, res: any) => {
      res.set({ "Content-Type": "application/zip" });
      res.end(Buffer.from("PK\x03\x04zip"));
    });

    const res = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    }) as any;
    res.set = jest.fn();
    res.status = jest.fn().mockReturnThis();
    res.headersSent = false;

    const controller = new SharingController(
      mockService as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );
    await controller.downloadShare("tok", { password: "" }, res as any);

    expect(mockService.listArchiveMembers).toHaveBeenCalled();
    expect(mockService.incrementFolderArchiveDownloadCount).toHaveBeenCalledWith("tok");
    expect(mockService.incrementDownloadCount).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "application/zip",
        "Cache-Control": "no-store",
      }),
    );
  });

  it("should stream file data for valid public share", async () => {
    const tempFile = path.join("/tmp", `share-test-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, Buffer.from("PDF data"));

    const setMock = jest.fn();
    const writeCalls: Buffer[] = [];

    const mockRes = new Writable({
      write(chunk, encoding, callback) {
        writeCalls.push(chunk);
        callback();
      },
    }) as any;
    mockRes.set = setMock;

    const mockService = {
      findShareByToken: jest.fn(),
      verifySharePassword: jest.fn(),
      incrementDownloadCount: jest.fn(),
    };

    mockService.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: {
        id: 1,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 9,
        isFolder: false,
        storagePath: tempFile,
      },
    });
    mockService.incrementDownloadCount.mockResolvedValue({});

    const controller = new SharingController(
      mockService as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );
    const promise = controller.downloadShare("tok", { password: "" }, mockRes);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await promise;

    expect(mockService.incrementDownloadCount).toHaveBeenCalledWith("tok");
    expect(setMock).toHaveBeenCalledWith({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="report.pdf"',
      "Accept-Ranges": "bytes",
      "Content-Length": "8",
    });
    expect(writeCalls.length).toBeGreaterThan(0);
    expect(Buffer.concat(writeCalls).toString()).toBe("PDF data");

    fs.rmSync(tempFile, { force: true });
  });

  it("should forward maxDownloads from DTO to the sharing service", async () => {
    const mockService = {
      createShareLink: jest.fn().mockResolvedValue({
        id: 4,
        token: "tok",
        fileId: 7,
        password: "bcrypt-hash",
        isFolder: false,
        isActive: true,
        maxDownloads: 3,
      }),
    };
    const controller = new SharingController(mockService as any, {} as any);

    const result = await controller.createShareLink(
      { user: { userId: 1 } } as any,
      { fileId: 7, maxDownloads: 3, isFolder: false } as any,
    );

    expect(mockService.createShareLink).toHaveBeenCalledWith(1, 7, {
      password: undefined,
      expiresInDays: undefined,
      maxDownloads: 3,
      isFolder: false,
    });
    expect(result).toMatchObject({ id: 4, token: "tok", fileId: 7 });
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("user");
  });

  it("does not expose password hashes or user records when listing shares", async () => {
    const mockService = {
      listUserShares: jest.fn().mockResolvedValue([{
        id: 8,
        token: "listed",
        fileId: 12,
        password: "bcrypt-hash",
        user: { id: 1, password: "user-hash" },
        isFolder: false,
        isActive: true,
        maxDownloads: null,
        file: { id: 12, name: "safe.png", isFolder: false, folderId: null, storagePath: "/secret" },
      }]),
    };
    const controller = new SharingController(mockService as any, {} as any);

    const result = await controller.listShares({ user: { userId: 1 } } as any);

    expect(result[0]).toMatchObject({ token: "listed", file: { name: "safe.png" } });
    expect(result[0]).not.toHaveProperty("password");
    expect(result[0]).not.toHaveProperty("user");
    expect(result[0].file).not.toHaveProperty("storagePath");
  });
});


describe("Public display metadata boundary", () => {
  const share = (password: string | null = null, isFolder = false) => ({ token: "tok", fileId: 1, isFolder, password, file: { name: "safe.pdf", size: "12698", mimeType: "application/pdf", storagePath: "/secret", checksum: "private" }, user: { email: "private" } });
  it("projects only name, persisted size and MIME for unprotected files", async () => {
    const controller = new SharingController({ findShareByToken: jest.fn().mockResolvedValue(share()) } as any, {} as any);
    const result = await controller.getPublicShare("tok");
    expect(result.resource).toEqual({ name: "safe.pdf", size: "12698", mimeType: "application/pdf" });
    expect(result).not.toHaveProperty("user");
    expect(result).not.toHaveProperty("password");
  });
  it("does not disclose metadata before password verification", async () => {
    const controller = new SharingController({ findShareByToken: jest.fn().mockResolvedValue(share("hash")) } as any, {} as any);
    expect(await controller.getPublicShare("tok")).not.toHaveProperty("resource");
  });
  it("rechecks availability after verification and projects protected metadata", async () => {
    const service = { verifySharePassword: jest.fn().mockResolvedValue(true), findShareByToken: jest.fn().mockResolvedValue(share("hash")) };
    const controller = new SharingController(service as any, {} as any);
    expect(await controller.verifyPassword("tok", { password: "fixture" })).toEqual({ success: true, resource: { name: "safe.pdf", size: "12698", mimeType: "application/pdf" } });
    expect(service.findShareByToken).toHaveBeenCalledWith("tok");
    service.findShareByToken.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.verifyPassword("tok", { password: "fixture" })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("does not project metadata after wrong password", async () => {
    const service = { verifySharePassword: jest.fn().mockRejectedValue(new BadRequestException()), findShareByToken: jest.fn() };
    const controller = new SharingController(service as any, {} as any);
    await expect(controller.verifyPassword("tok", { password: "wrong" })).rejects.toBeInstanceOf(BadRequestException);
    expect(service.findShareByToken).not.toHaveBeenCalled();
  });
  it("never presents folder mirror size or MIME as aggregate metadata", async () => {
    const controller = new SharingController({ findShareByToken: jest.fn().mockResolvedValue(share(null, true)) } as any, {} as any);
    expect((await controller.getPublicShare("tok")).resource).toEqual({ name: "safe.pdf", size: null, mimeType: null });
  });
});
