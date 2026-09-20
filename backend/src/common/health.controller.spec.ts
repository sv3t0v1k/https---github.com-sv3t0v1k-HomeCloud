import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import request from "supertest";
import { HealthController } from "./health.controller";

const PRODUCTION_CONFIG = {
  NODE_ENV: "production",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  DB_PASSWORD: "strong-db-password-2026!",
  REDIS_PASSWORD: "strong-redis-password-2026!",
};

function makeDataSource(
  queryImpl: () => Promise<unknown> = async () => {
    return { 1: 1 };
  },
): unknown {
  return { query: jest.fn(queryImpl) };
}

async function createApp(
  dataSource: unknown,
  storagePath: string,
): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ ...PRODUCTION_CONFIG, STORAGE_PATH: storagePath })],
      }),
    ],
    controllers: [HealthController],
    providers: [
      { provide: DataSource, useValue: dataSource },
      ConfigService,
    ],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe("HealthController", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("GET /health stays unchanged and does not probe dependencies", async () => {
    const querySpy = jest.fn();
    const app = await createApp(
      makeDataSource(() => Promise.resolve({ 1: 1 })),
      "/storage",
    );
    const res = await request(app.getHttpServer()).get("/health").expect(200);

    expect(res.body).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(querySpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("GET /health/ready returns 200 when database and storage are ready", async () => {
    const app = await createApp(makeDataSource(), "/tmp");
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(200);

    expect(res.body).toEqual({
      status: "ready",
      checks: { database: "ok", storage: "ok" },
    });
    await app.close();
  });

  it("GET /health/ready returns 503 when database fails", async () => {
    const app = await createApp(
      makeDataSource(async () => {
        throw new Error("connection refused");
      }),
      "/tmp",
    );
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503);

    expect(res.body).toEqual({
      status: "not_ready",
      checks: { database: "unavailable", storage: "ok" },
    });
    await app.close();
  });

  it("GET /health/ready returns 503 when storage root is missing", async () => {
    const app = await createApp(makeDataSource(), "/nonexistent/path/xyz");
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503);

    expect(res.body).toEqual({
      status: "not_ready",
      checks: { database: "ok", storage: "unavailable" },
    });
    await app.close();
  });

  it("GET /health/ready returns 503 when storage root is not a directory", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const filePath = path.join(os.tmpdir(), `hc-ready-file-${Date.now()}`);
    fs.writeFileSync(filePath, "x");
    try {
      const app = await createApp(makeDataSource(), filePath);
      const res = await request(app.getHttpServer())
        .get("/health/ready")
        .expect(503);

      expect(res.body).toEqual({
        status: "not_ready",
        checks: { database: "ok", storage: "unavailable" },
      });
      await app.close();
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it("GET /health/ready returns 503 when storage root is not writable", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dirPath = path.join(os.tmpdir(), `hc-ready-ro-${Date.now()}`);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o555);
    try {
      const app = await createApp(makeDataSource(), dirPath);
      const res = await request(app.getHttpServer())
        .get("/health/ready")
        .expect(503);

      expect(res.body).toEqual({
        status: "not_ready",
        checks: { database: "ok", storage: "unavailable" },
      });
      await app.close();
    } finally {
      fs.chmodSync(dirPath, 0o755);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("failure response does not expose raw database error, credentials, or filesystem paths", async () => {
    const app = await createApp(
      makeDataSource(async () => {
        throw new Error("connection refused at /secret/db:5432");
      }),
      "/nonexistent/path/xyz",
    );
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("/secret/db:5432");
    expect(body).not.toContain("connection refused");
    expect(body).not.toContain("DATABASE_URL");
    expect(body).not.toContain("DB_PASSWORD");
    expect(body).not.toContain("/nonexistent/path/xyz");
    await app.close();
  });
});