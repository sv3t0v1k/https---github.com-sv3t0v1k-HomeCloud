import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

describe("public browser download HTTP boundary", () => {
  let app: INestApplication;
  let directory: string;
  let filePath: string;
  const sharing = {
    findShareByToken: jest.fn(),
    verifySharePassword: jest.fn(),
    incrementDownloadCount: jest.fn(),
    listArchiveMembers: jest.fn(),
    incrementFolderArchiveDownloadCount: jest.fn(),
    streamFolderArchive: jest.fn(),
  };

  const browserRequest = () =>
    request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .set("Accept", "text/html")
      .type("form")
      .send({ browserDownload: "1", password: "" });

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hc-browser-share-"));
    filePath = path.join(directory, "synthetic.txt");
    fs.writeFileSync(filePath, "synthetic public download");
    const module = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: sharing },
        {
          provide: StorageService,
          useValue: {
            resolveFilePath: () => filePath,
            ensureWithinStorageRoot: (resolved: string) => resolved,
          },
        },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    sharing.findShareByToken.mockResolvedValue({
      token: "tok",
      password: null,
      file: {
        id: 1,
        name: "synthetic.txt",
        mimeType: "text/plain",
        isFolder: false,
        storagePath: filePath,
      },
    });
    sharing.incrementDownloadCount.mockResolvedValue({ downloadCount: 1 });
  });

  it("keeps a successful browser response streaming with its attachment header", async () => {
    const response = await browserRequest().expect(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="synthetic.txt"',
    );
    expect(response.headers["content-length"]).toBe(
      String(fs.statSync(filePath).size),
    );
    expect(response.headers.location).toBeUndefined();
    expect(sharing.incrementDownloadCount).toHaveBeenCalledTimes(1);
  });

  it("returns only a safe code when the last slot has been used", async () => {
    sharing.incrementDownloadCount.mockRejectedValue(
      new NotFoundException("internal database detail"),
    );
    const response = await browserRequest().expect(303);
    expect(response.headers.location).toBe(
      "/share/tok?downloadError=unavailable",
    );
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).not.toContain("internal database detail");
    expect(sharing.incrementDownloadCount).toHaveBeenCalledTimes(1);
  });

  it("redirects a wrong browser-form password without putting it in the URL", async () => {
    sharing.findShareByToken.mockResolvedValueOnce({
      token: "tok",
      password: "stored-hash",
      file: { id: 1, isFolder: false, storagePath: filePath },
    });
    sharing.verifySharePassword.mockRejectedValueOnce(
      new ForbiddenException("secret password detail"),
    );
    const response = await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .set("Accept", "text/html")
      .type("form")
      .send({ browserDownload: "1", password: "private-password" })
      .expect(303);
    expect(response.headers.location).toBe("/share/tok?downloadError=forbidden");
    expect(response.headers.location).not.toContain("private-password");
    expect(response.text).not.toContain("secret password detail");
    expect(sharing.incrementDownloadCount).not.toHaveBeenCalled();
  });

  it.each(["expired", "revoked"])(
    "returns an unavailable browser page for an %s link",
    async () => {
      sharing.findShareByToken.mockRejectedValueOnce(new NotFoundException());
      const response = await browserRequest().expect(303);
      expect(response.headers.location).toBe(
        "/share/tok?downloadError=unavailable",
      );
      expect(sharing.incrementDownloadCount).not.toHaveBeenCalled();
    },
  );

  it("preserves JSON API errors even when a JSON client copies the marker", async () => {
    sharing.incrementDownloadCount.mockRejectedValueOnce(new NotFoundException());
    const markedJson = await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .set("Accept", "text/html")
      .send({ browserDownload: "1" })
      .expect(404);
    sharing.incrementDownloadCount.mockRejectedValueOnce(new NotFoundException());
    const ordinaryJson = await request(app.getHttpServer())
      .post("/api/v1/sharing/public/tok/download")
      .send({})
      .expect(404);
    expect(markedJson.headers.location).toBeUndefined();
    expect(ordinaryJson.headers.location).toBeUndefined();
  });

  it("returns one attachment and one safe redirect for concurrent requests to one slot", async () => {
    let slots = 1;
    sharing.incrementDownloadCount.mockImplementation(async () => {
      if (slots-- > 0) return { downloadCount: 1 };
      throw new NotFoundException("limit exhausted");
    });
    const responses = await Promise.all([browserRequest(), browserRequest()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 303,
    ]);
    expect(
      responses.find((response) => response.status === 303)?.headers.location,
    ).toBe("/share/tok?downloadError=unavailable");
    expect(sharing.incrementDownloadCount).toHaveBeenCalledTimes(2);
  });

  it("clears attachment headers when a ZIP fails before streaming", async () => {
    sharing.findShareByToken.mockResolvedValueOnce({
      token: "tok",
      password: null,
      file: { id: 2, name: "folder", isFolder: true },
    });
    sharing.listArchiveMembers.mockResolvedValueOnce([]);
    sharing.incrementFolderArchiveDownloadCount.mockResolvedValueOnce({
      downloadCount: 1,
    });
    sharing.streamFolderArchive.mockRejectedValueOnce(new Error("private path"));
    const response = await browserRequest().expect(303);
    expect(response.headers.location).toBe("/share/tok?downloadError=failed");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).not.toContain("private path");
    expect(sharing.incrementFolderArchiveDownloadCount).toHaveBeenCalledTimes(1);
  });
});
