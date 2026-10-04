import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

describe("FilesController authenticated original download", () => {
  let app: INestApplication;
  let storageRoot: string;
  let fixturePath: string;

  const findOne = jest.fn();
  const storage = {
    ensureWithinStorageRoot(target: string) {
      const resolved = path.resolve(target);
      const root = path.resolve(storageRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("Path traversal detected");
      }
      return resolved;
    },
  };

  beforeAll(async () => {
    storageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hc-owner-download-")),
    );
    fixturePath = path.join(storageRoot, "fixture.bin");
    fs.writeFileSync(fixturePath, Buffer.from("0123456789ABCDEF"));

    const moduleRef = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: { findOne } },
        { provide: StorageService, useValue: storage },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          const authorization = req.headers.authorization;
          if (!authorization) throw new UnauthorizedException();
          req.user = { userId: authorization === "Bearer owner" ? 42 : 99 };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    findOne.mockReset();
    findOne.mockImplementation(async (userId: number, id: number) => {
      if (userId !== 42 || id !== 7)
        throw new NotFoundException("File not found");
      return {
        id: 7,
        userId: 42,
        name: 'report\r\nX-Evil: yes".bin',
        size: 16,
        storagePath: fixturePath,
        isFolder: false,
        isDeleted: false,
        mimeType: "application/octet-stream",
      };
    });
  });

  const get = (range?: string, token = "owner") => {
    let call = request(app.getHttpServer())
      .get("/api/v1/files/7/download")
      .set("Authorization", `Bearer ${token}`);
    if (range) call = call.set("Range", range);
    return call.buffer(true);
  };

  it("requires authentication and keeps cross-user lookup private", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/files/7/download")
      .expect(401);

    await get(undefined, "other").expect(404);
    expect(findOne).toHaveBeenLastCalledWith(99, 7);
  });

  it("returns 404 for a missing/deleted file and rejects a folder", async () => {
    findOne.mockRejectedValueOnce(new NotFoundException("File not found"));
    expect((await get().expect(404)).status).toBe(404);

    findOne.mockResolvedValueOnce({
      id: 7,
      isFolder: false,
      isDeleted: true,
      storagePath: fixturePath,
    });
    expect((await get().expect(404)).status).toBe(404);

    findOne.mockResolvedValueOnce({ id: 7, isFolder: true });
    expect((await get().expect(400)).status).toBe(400);
  });

  it("streams the complete original with exact safe headers", async () => {
    const result = await get().expect(200);

    expect(result.body).toEqual(Buffer.from("0123456789ABCDEF"));
    expect(result.headers["content-length"]).toBe("16");
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect(result.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(result.headers["content-disposition"]).toBe(
      "attachment; filename=\"report__X-Evil: yes_.bin\"; filename*=UTF-8''report__X-Evil%3A%20yes%22.bin",
    );
  });

  it.each([
    "Русский файл.BIN",
    'Фото "лето".JPEG',
    "archive's (final)*.7Z",
    "日本語 🔒.unknown",
  ])(
    "preserves exact Unicode and special characters in download filename %s",
    async (name) => {
      findOne.mockResolvedValueOnce({
        id: 7,
        name,
        storagePath: fixturePath,
        isFolder: false,
        isDeleted: false,
        mimeType: "application/octet-stream",
      });
      const result = await get().expect(200);
      const disposition = result.headers["content-disposition"];
      expect(disposition).toMatch(
        /^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]*"; filename\*=UTF-8''/,
      );
      const encoded = disposition.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toBe(name);
      expect(encoded).not.toMatch(/["'()*]/);
      expect(result.headers["x-evil"]).toBeUndefined();
      expect(result.body).toEqual(Buffer.from("0123456789ABCDEF"));
    },
  );

  it("sanitizes legacy controls in both download filename parameters", async () => {
    const result = await get().expect(200);
    const disposition = result.headers["content-disposition"];
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(
      'report__X-Evil: yes".bin',
    );
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(result.headers["x-evil"]).toBeUndefined();
  });

  it.each([
    ["bytes=0-0", "bytes 0-0/16", "0"],
    ["bytes=10-19", "bytes 10-15/16", "ABCDEF"],
    ["bytes=10-", "bytes 10-15/16", "ABCDEF"],
    ["bytes=-10", "bytes 6-15/16", "6789ABCDEF"],
    ["bytes=14-15", "bytes 14-15/16", "EF"],
  ])("supports single range %s", async (range, contentRange, body) => {
    const result = await get(range).expect(206);
    expect(result.headers["content-range"]).toBe(contentRange);
    expect(result.headers["content-length"]).toBe(String(body.length));
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect(result.body).toEqual(Buffer.from(body));
  });

  it.each(["bytes=16-", "bytes=5-3", "bytes=abc", "bytes=0-0,1-1"])(
    "returns 416 with resource size for %s",
    async (range) => {
      const result = await get(range).expect(416);
      expect(result.headers["content-range"]).toBe("bytes */16");
      expect(result.headers["accept-ranges"]).toBe("bytes");
      expect(result.body.length).toBe(0);
    },
  );

  it("uses exact size above uint32 for late-range header math", async () => {
    const sparsePath = path.join(storageRoot, "large-sparse.bin");
    const size = 4_294_967_313;
    const start = Math.floor(size * 0.8);
    fs.closeSync(fs.openSync(sparsePath, "w"));
    fs.truncateSync(sparsePath, size);
    findOne.mockResolvedValueOnce({
      id: 7,
      userId: 42,
      name: "large.bin",
      size: String(size),
      storagePath: sparsePath,
      isFolder: false,
      isDeleted: false,
      mimeType: "application/octet-stream",
    });

    const result = await get(`bytes=${start}-${start}`).expect(206);
    expect(result.headers["content-range"]).toBe(
      `bytes ${start}-${start}/${size}`,
    );
    expect(result.headers["content-length"]).toBe("1");
    expect(result.body).toEqual(Buffer.from([0]));
  });

  it("rejects paths outside storage and non-regular targets", async () => {
    findOne.mockResolvedValueOnce({
      id: 7,
      name: "outside.bin",
      storagePath: path.join(os.tmpdir(), "outside.bin"),
      isFolder: false,
      isDeleted: false,
    });
    expect((await get().expect(404)).status).toBe(404);

    findOne.mockResolvedValueOnce({
      id: 7,
      name: "directory",
      storagePath: storageRoot,
      isFolder: false,
      isDeleted: false,
    });
    expect((await get().expect(404)).status).toBe(404);
  });

  it("rejects a symlink escaping the storage root", async () => {
    const outsideDirectory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hc-owner-outside-")),
    );
    const outsideFile = path.join(outsideDirectory, "secret.bin");
    const link = path.join(storageRoot, "escape.bin");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, link);
    findOne.mockResolvedValueOnce({
      id: 7,
      name: "escape.bin",
      storagePath: link,
      isFolder: false,
      isDeleted: false,
    });

    try {
      expect((await get().expect(404)).status).toBe(404);
    } finally {
      fs.rmSync(outsideDirectory, { recursive: true, force: true });
      fs.rmSync(link, { force: true });
    }
  });

  it("falls back from unsafe MIME metadata", async () => {
    findOne.mockResolvedValueOnce({
      id: 7,
      name: "fixture.bin",
      storagePath: fixturePath,
      isFolder: false,
      isDeleted: false,
      mimeType: "text/plain\r\nX-Evil: yes",
    });

    const result = await get().expect(200);
    expect(result.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(result.headers["x-evil"]).toBeUndefined();
  });

  it("HEAD is handled by Nest/Express with headers and no response body", async () => {
    const result = await request(app.getHttpServer())
      .head("/api/v1/files/7/download")
      .set("Authorization", "Bearer owner")
      .expect(200);
    expect(result.headers["content-length"]).toBe("16");
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect(result.body).toEqual({});
  });
});
