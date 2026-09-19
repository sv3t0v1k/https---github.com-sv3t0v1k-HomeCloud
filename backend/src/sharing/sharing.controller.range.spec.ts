import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as http from "http";
import { AddressInfo } from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";
import { StorageService } from "../storage/storage.service";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { NotFoundException } from "@nestjs/common";

const TOKEN = "test-token";

type ShareFile = {
  id: number;
  name: string;
  size: number;
  storagePath: string;
  isFolder: boolean;
  mimeType: string;
};

function buildShare(file: ShareFile, password: string | null = null) {
  return {
    token: TOKEN,
    fileId: file.id,
    isFolder: file.isFolder,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    downloadCount: 0,
    createdAt: new Date(),
    isActive: true,
    password,
    file,
  };
}

const mockService = {
  findShareByToken: jest.fn(),
  verifySharePassword: jest.fn(),
  incrementDownloadCount: jest.fn(),
};

const mockStorage = {
  ensureWithinStorageRoot: (p: string) => p,
  getStoragePath: () => "/storage",
  getFileSize: () => 0,
};

describe("SharingController download — HTTP Range (integration)", () => {
  let app: INestApplication;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SharingController],
      providers: [
        { provide: SharingService, useValue: mockService },
        { provide: StorageService, useValue: mockStorage },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => Promise.resolve(true) })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();

    // `getHttpServer()` returns Nest's cached http.Server (not a request-listener
    // function), so we must NOT wrap it again in createServer — doing so makes
    // Node invoke the server object as a listener and every request hangs.
    server = app.getHttpServer() as unknown as http.Server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    try {
      server.closeAllConnections?.();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    await app.close();
  });

  beforeEach(() => {
    mockService.findShareByToken.mockReset();
    mockService.verifySharePassword.mockReset();
    mockService.verifySharePassword.mockResolvedValue(true);
    mockService.incrementDownloadCount.mockReset();
    mockService.incrementDownloadCount.mockResolvedValue({});
  });

  function makeFile(buffer: Buffer): string {
    const file = path.join(
      os.tmpdir(),
      `hc-range-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`,
    );
    fs.writeFileSync(file, buffer);
    return file;
  }

  function shareFor(file: string, buffer: Buffer) {
    mockService.findShareByToken.mockResolvedValue(
      buildShare({
        id: 1,
        name: "file.bin",
        size: buffer.length,
        storagePath: file,
        isFolder: false,
        mimeType: "application/octet-stream",
      }),
    );
  }

  function doRequest(range?: string): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Connection: "close",
      };
      if (range) headers["Range"] = range;
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/api/v1/sharing/public/${TOKEN}/download`,
          method: "POST",
          headers,
          timeout: 6000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("request timeout"));
      });
      req.write(JSON.stringify({}));
      req.end();
    });
  }

  async function run(buffer: Buffer, range?: string) {
    const file = makeFile(buffer);
    try {
      shareFor(file, buffer);
      return await doRequest(range);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  it("200 no-range: full body + Accept-Ranges + Content-Length", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe("16");
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.body).toEqual(Buffer.from("0123456789ABCDEF"));
    expect(mockService.incrementDownloadCount).toHaveBeenCalledWith(TOKEN);
  });

  it("206 bytes=0-3 -> first 4 bytes", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=0-3");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-3/16");
    expect(res.headers["content-length"]).toBe("4");
    expect(res.body).toEqual(Buffer.from("0123"));
  });

  it("206 bytes=12-15 -> last 4 bytes", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=12-15");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 12-15/16");
    expect(res.body).toEqual(Buffer.from("CDEF"));
  });

  it("206 bytes=0- -> open-ended to EOF", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=0-");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-15/16");
    expect(res.body).toEqual(Buffer.from("0123456789ABCDEF"));
  });

  it("206 bytes=-4 -> suffix (last 4)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=-4");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 12-15/16");
    expect(res.body).toEqual(Buffer.from("CDEF"));
  });

  it("206 bytes=0-0 -> single first byte", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=0-0");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-0/16");
    expect(res.headers["content-length"]).toBe("1");
    expect(res.body).toEqual(Buffer.from("0"));
  });

  it("206 bytes=0-100 -> end clamped to EOF", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=0-100");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-15/16");
    expect(res.body).toEqual(Buffer.from("0123456789ABCDEF"));
  });

  it("416 bytes=16- (start>=size)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=16-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
    expect(res.body.length).toBe(0);
  });

  it("416 bytes=5-3 (start>end)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=5-3");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
  });

  it("416 bytes=abc (malformed)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=abc");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
  });

  it("416 bytes=0-0,1-1 (multiple ranges)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "bytes=0-0,1-1");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
  });

  it("416 non-bytes unit (items=0-3)", async () => {
    const res = await run(Buffer.from("0123456789ABCDEF"), "items=0-3");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
  });

  it("empty file: 200 no-range, Content-Length 0", async () => {
    const res = await run(Buffer.alloc(0), undefined);
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("0");
    expect(res.body.length).toBe(0);
  });

  it("empty file: bytes=0- -> 416 bytes */0", async () => {
    const res = await run(Buffer.alloc(0), "bytes=0-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */0");
  });

  it("1-byte file: bytes=0-0 -> 206 single byte", async () => {
    const res = await run(Buffer.from("X"), "bytes=0-0");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-0/1");
    expect(res.body).toEqual(Buffer.from("X"));
  });

  it("1-byte file: bytes=1- -> 416", async () => {
    const res = await run(Buffer.from("X"), "bytes=1-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1");
  });

  it("expired link -> 404, download not incremented (fail-closed)", async () => {
    const file = makeFile(Buffer.from("0123456789ABCDEF"));
    try {
      mockService.findShareByToken.mockRejectedValue(
        new NotFoundException("Share link not found or expired"),
      );
      const res = await doRequest("bytes=0-3");
      expect(res.status).toBe(404);
      expect(mockService.incrementDownloadCount).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
