import { NotFoundException, BadRequestException } from "@nestjs/common";
import { SharingController } from "./sharing.controller";
import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";

/**
 * TEST-ONLY coverage for the scoped descendant download path inside
 * SharingController.downloadShare. No production code is modified.
 */
describe("SharingController — scoped descendant download streaming", () => {
  const tempDir = path.join("/tmp", `homecloud-folder-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let tempFile: string;

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    tempFile = path.join(tempDir, "child.txt");
    fs.writeFileSync(tempFile, Buffer.from("hello-scoped-world"));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  function makeRes() {
    const writeCalls: Buffer[] = [];
    const setMock = jest.fn();
    const res = new Writable({
      write(chunk, encoding, callback) {
        writeCalls.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as any;
    res.set = setMock;
    res.status = jest.fn().mockReturnThis();
    res.end = jest.fn();
    res.headersSent = false;
    return { res, writeCalls, setMock };
  }

  function makeService(overrides: any = {}) {
    return {
      findShareByToken: jest.fn().mockResolvedValue(overrides.share ?? {
        token: "tok",
        password: null,
        file: {
          id: 900,
          name: "Root",
          mimeType: "application/zip",
          size: 0,
          isFolder: true,
          folderId: 40,
          storagePath: null,
        },
      }),
      verifySharePassword: jest.fn().mockResolvedValue(true),
      resolveSharedFolderFile: jest.fn().mockResolvedValue(overrides.file ?? {
        id: 1300,
        name: "child.txt",
        mimeType: "text/plain",
        size: 18,
        isFolder: false,
        isDeleted: false,
        storagePath: tempFile,
      }),
      incrementFolderDownloadCount: jest.fn().mockResolvedValue({ downloadCount: 1 }),
      incrementDownloadCount: jest.fn().mockResolvedValue({ downloadCount: 1 }),
    };
  }

  it("streams a full 200 descendant file and consumes one slot", async () => {
    const { res, writeCalls, setMock } = makeRes();
    const service = makeService();
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    const promise = controller.downloadShare("tok", { password: "", fileId: 1300 }, res, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await promise;

    expect(service.resolveSharedFolderFile).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok" }),
      1300,
    );
    expect(service.incrementFolderDownloadCount).toHaveBeenCalledWith("tok", 1300);
    expect(service.incrementDownloadCount).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "text/plain",
        "Content-Length": "18",
        "Accept-Ranges": "bytes",
      }),
    );
    expect(Buffer.concat(writeCalls).toString()).toBe("hello-scoped-world");
  });

  it("streams a 206 Range for a descendant file with correct headers", async () => {
    const { res, writeCalls, setMock } = makeRes();
    const service = makeService();
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    const promise = controller.downloadShare(
      "tok",
      { password: "", fileId: 1300 },
      res,
      { headers: { range: "bytes=0-4" } } as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await promise;

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Range": "bytes 0-4/18",
        "Content-Length": "5",
      }),
    );
    expect(Buffer.concat(writeCalls).toString()).toBe("hello");
    expect(service.incrementFolderDownloadCount).toHaveBeenCalledTimes(1);
  });

  it("returns 416 for an unsatisfiable Range and consumes NO slot", async () => {
    const { res, setMock } = makeRes();
    const service = makeService();
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    await controller.downloadShare(
      "tok",
      { password: "", fileId: 1300 },
      res,
      { headers: { range: "bytes=100-200" } } as any,
    );

    expect(res.status).toHaveBeenCalledWith(416);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes */18",
      }),
    );
    expect(service.incrementFolderDownloadCount).not.toHaveBeenCalled();
    expect(service.incrementDownloadCount).not.toHaveBeenCalled();
  });

  it("does not consume a slot when the descendant file is missing from storage", async () => {
    const { res } = makeRes();
    const service = makeService({
      file: {
        id: 1300,
        name: "ghost.txt",
        mimeType: "text/plain",
        size: 18,
        isFolder: false,
        isDeleted: false,
        storagePath: "/nonexistent/path/ghost.txt",
      },
    });
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    await expect(
      controller.downloadShare("tok", { password: "", fileId: 1300 }, res, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(service.incrementFolderDownloadCount).not.toHaveBeenCalled();
    expect(service.incrementDownloadCount).not.toHaveBeenCalled();
  });

  it("does not consume a slot when the descendant file is out of scope", async () => {
    const { res } = makeRes();
    const service = makeService();
    service.resolveSharedFolderFile = jest.fn().mockRejectedValue(new NotFoundException("Shared file not found"));
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    await expect(
      controller.downloadShare("tok", { password: "", fileId: 9999 }, res, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(service.incrementFolderDownloadCount).not.toHaveBeenCalled();
    expect(service.incrementDownloadCount).not.toHaveBeenCalled();
  });

  it("rejects folder archive download without fileId and consumes nothing", async () => {
    const { res } = makeRes();
    const service = makeService();
    const controller = new SharingController(
      service as any,
      { ensureWithinStorageRoot: (p: string) => p } as any,
    );

    await expect(
      controller.downloadShare("tok", { password: "" }, res, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(service.resolveSharedFolderFile).not.toHaveBeenCalled();
    expect(service.incrementFolderDownloadCount).not.toHaveBeenCalled();
    expect(service.incrementDownloadCount).not.toHaveBeenCalled();
  });
});