import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import * as fs from "fs";
import * as path from "path";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

describe("SharingController - folder ZIP download", () => {
  let app: INestApplication;
  let tempDir: string;

  const sharing = {
    listSharedChildren: jest.fn(),
    findShareByToken: jest.fn(),
    verifySharePassword: jest.fn(),
    resolveSharedFolderFile: jest.fn(),
    incrementFolderDownloadCount: jest.fn(),
    incrementDownloadCount: jest.fn(),
    listArchiveMembers: jest.fn(),
    streamFolderArchive: jest.fn(),
    incrementFolderArchiveDownloadCount: jest.fn(),
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join("/tmp", "homecloud-zip-http-"));
    const module = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: sharing },
        {
          provide: StorageService,
          useValue: { ensureWithinStorageRoot: (p: string) => p },
        },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    return app.close();
  });
  beforeEach(() => jest.clearAllMocks());

  it("streams a ZIP for a folder share without fileId and consumes exactly one slot", async () => {
    const memberPath = path.join(tempDir, "a.txt");
    fs.writeFileSync(memberPath, Buffer.from("hello-zip"));
    sharing.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: { id: 900, name: "Root", isFolder: true, folderId: 40, storagePath: null },
    });
    sharing.listArchiveMembers.mockResolvedValue([
      { folderId: 40, name: "Root", logicalPath: "", isFolder: true, storagePath: null, size: 0 },
      { folderId: 100, name: "a.txt", logicalPath: "a.txt", isFolder: false, storagePath: memberPath, size: 9 },
    ]);
    sharing.incrementFolderArchiveDownloadCount.mockResolvedValue({ downloadCount: 1 });
    sharing.streamFolderArchive.mockImplementation(async (_share: any, res: any) => {
      res.set({ "Content-Type": "application/zip" });
      res.end(Buffer.from("PK\x03\x04fake-zip-bytes"));
    });

    const res = await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .send({});

    expect(sharing.listArchiveMembers).toHaveBeenCalled();
    expect(sharing.incrementFolderArchiveDownloadCount).toHaveBeenCalledWith("tok");
    expect(sharing.incrementFolderDownloadCount).not.toHaveBeenCalled();
    expect(sharing.incrementDownloadCount).not.toHaveBeenCalled();
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("rejects invalid fileId before any admission", async () => {
    sharing.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: { id: 900, name: "Root", isFolder: true, folderId: 40, storagePath: null },
    });
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .send({ fileId: 0 })
      .expect(400);
    expect(sharing.incrementFolderArchiveDownloadCount).not.toHaveBeenCalled();
    expect(sharing.incrementFolderDownloadCount).not.toHaveBeenCalled();
  });

  it("keeps descendant fileId download behavior unchanged", async () => {
    const childPath = path.join(tempDir, "child.txt");
    fs.writeFileSync(childPath, Buffer.from("child"));
    sharing.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: { id: 900, name: "Root", isFolder: true, folderId: 40, storagePath: null },
    });
    sharing.resolveSharedFolderFile.mockResolvedValue({
      id: 100,
      name: "child.txt",
      mimeType: "text/plain",
      size: 5,
      isFolder: false,
      storagePath: childPath,
    });
    sharing.incrementFolderDownloadCount.mockResolvedValue({ downloadCount: 1 });

    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .send({ fileId: 100 })
      .expect(200);

    expect(sharing.resolveSharedFolderFile).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok" }),
      100,
    );
    expect(sharing.incrementFolderDownloadCount).toHaveBeenCalledWith("tok", 100);
    expect(sharing.incrementFolderArchiveDownloadCount).not.toHaveBeenCalled();
  });
});