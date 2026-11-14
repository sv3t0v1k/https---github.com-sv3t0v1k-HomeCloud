import { Test } from "@nestjs/testing";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtService } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import request from "supertest";
import { PreviewsController } from "./previews.controller";
import { PreviewsService } from "./previews.service";

const CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

/**
 * Phase 11.3 — thumbnail cache boundary regression.
 * Verifies only the HTTP cache/auth contract (content generation is mocked).
 */
describe("PreviewsController thumbnail cache boundary (Phase 11.3)", () => {
  let app: any;
  const getThumbnail = jest.fn();
  const getPreview = jest.fn();
  const jwtVerify = jest.fn(() => ({ sub: 1, email: "u@t.c" }));

  beforeAll(async () => {
    getThumbnail.mockResolvedValue(Buffer.from("thumbnail-bytes"));
    getPreview.mockResolvedValue({
      type: "unsupported",
      content: "Preview not available",
      mimeType: "text/plain",
    });

    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => CONFIG] })],
      controllers: [PreviewsController],
      providers: [
        { provide: PreviewsService, useValue: { getThumbnail, getPreview } },
        { provide: JwtService, useValue: { verify: jwtVerify, sign: jest.fn() } },
        { provide: JwtStrategy, useValue: { validate: async () => ({ userId: 1, email: "u@t.c" }) } },
      ],
    }).compile();

    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  const authed = () =>
    request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("Authorization", "Bearer header.payload.signature");

  it("authenticated thumbnail → private cache policy, not public, content unchanged", async () => {
    const res = await authed();

    expect(res.status).toBe(200);
    const cc = (res.headers["cache-control"] as string) || "";
    expect(cc).toContain("private");
    expect(cc).toContain("no-store");
    expect(cc).not.toContain("max-age");
    expect(cc).not.toContain("public");
    expect((res.headers["vary"] as string) || "").toContain("Authorization");
    expect(res.headers["content-type"]).toContain("image/png");
    expect(getThumbnail).toHaveBeenCalledWith(
      1, 1, expect.any(AbortSignal),
    );
  });

  it.each([
    "0",
    "-1",
    "1abc",
    "9007199254740992",
    "1.5",
  ])("rejects malformed thumbnail ID %s before service access", async (id) => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/previews/${id}/thumbnail`)
      .set("Authorization", "Bearer header.payload.signature");

    expect(res.status).toBe(400);
    expect(getThumbnail).not.toHaveBeenCalled();
  });

  it("aborts processing after real HTTP disconnect", async () => {
    let entered!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      entered = resolve;
    });

    let finish!: (buffer: Buffer) => void;
    const work = new Promise<Buffer>((resolve) => {
      finish = resolve;
    });

    getThumbnail.mockImplementationOnce(
      (_userId: number, _fileId: number, signal: AbortSignal) => {
        entered(signal);
        return work;
      },
    );

    const client = authed().end(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(
            new Error("HTTP disconnect test timed out"),
          ), 3_000);
        }),
      ]);

    try {
      const signal = await deadline(started);
      if (timer) clearTimeout(timer);

      const disconnected = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

      client.abort();
      await deadline(disconnected);
      expect(signal.aborted).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      client.abort();
      finish(Buffer.from("thumbnail-bytes"));
    }
  }, 10_000);

  it("aborts ordinary preview after HTTP disconnect", async () => {
    let enter!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      enter = resolve;
    });

    let finish!: () => void;
    const pending = new Promise<object>((resolve) => {
      finish = () => resolve({
        type: "unsupported",
        content: "unavailable",
        mimeType: "text/plain",
      });
    });

    getPreview.mockImplementationOnce(
      (_userId: number, _fileId: number, signal: AbortSignal) => {
        enter(signal);
        return pending;
      },
    );

    const client = request(app.getHttpServer())
      .get("/api/v1/previews/1")
      .set("Authorization", "Bearer header.payload.signature")
      .end(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Preview HTTP disconnect timed out")),
            3_000,
          );
        }),
      ]);

    try {
      const signal = await deadline(started);
      if (timer) clearTimeout(timer);

      const disconnected = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

      client.abort();
      await deadline(disconnected);
      expect(signal.aborted).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      client.abort();
      finish();
    }
  }, 10_000);

  it("legacy preview is authenticated and never publicly cached", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/previews/1")
      .set("Authorization", "Bearer header.payload.signature");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["vary"]).toContain("Authorization");
    expect(getPreview).toHaveBeenCalledWith(1, 1, expect.any(AbortSignal));
  });

  it("missing Authorization → auth requirement enforced (guard rejects)", async () => {
    const res = await request(app.getHttpServer()).get(
      "/api/v1/previews/1/thumbnail",
    );

    expect([401, 403]).toContain(res.status);
    expect(getThumbnail).not.toHaveBeenCalled();
  });
});
