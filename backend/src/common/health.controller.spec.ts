import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { HttpExceptionFilter } from "./errors/http-exception.filter";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let root: string;
  let connect: jest.Mock;
  let query: jest.Mock;
  let end: jest.Mock;
  let options: Record<string, unknown>;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-health-"));
    await fs.mkdir(path.join(root, ".tmp"));
    connect = jest.fn().mockResolvedValue(undefined);
    query = jest.fn().mockResolvedValue([{ one: 1 }]);
    end = jest.fn().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  async function app() {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: ConfigService, useValue: { get: () => root } },
        {
          provide: DataSource,
          useValue: {
            options: { url: "postgres://test" },
            driver: {
              postgres: {
                Client: class {
                  constructor(value: Record<string, unknown>) {
                    options = value;
                  }
                  connect = connect;
                  query = query;
                  end = end;
                },
              },
            },
          },
        },
      ],
    }).compile();
    const instance = module.createNestApplication();
    instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init();
    return instance;
  }
  it("liveness does not touch dependencies", async () => {
    const instance = await app();
    for (const endpoint of ["/health", "/health/live"]) {
      const response = await request(instance.getHttpServer())
        .get(endpoint)
        .expect(200);
      expect(response.body.status).toBe("ok");
    }
    expect(connect).not.toHaveBeenCalled();
    await instance.close();
  });
  it("probes root and temporary storage safely and bounds the dedicated database connection", async () => {
    await fs.writeFile(path.join(root, "user-data"), "preserve");
    const instance = await app();
    const response = await request(instance.getHttpServer())
      .get("/health/ready")
      .expect(200);
    expect(response.body).toEqual({
      status: "ready",
      checks: { database: "ok", storage: "ok" },
    });
    expect(options).toMatchObject({
      connectionTimeoutMillis: 1000,
      query_timeout: 1500,
      options: "-c statement_timeout=1000",
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual(
      expect.arrayContaining([".tmp", "user-data"]),
    );
    expect(await fs.readdir(path.join(root, ".tmp"))).toEqual([]);
    expect(await fs.readFile(path.join(root, "user-data"), "utf8")).toBe(
      "preserve",
    );
    await instance.close();
  });
  it("database failure returns safe 503 and closes the client", async () => {
    connect.mockRejectedValue(new Error("secret postgres://credentials"));
    const instance = await app();
    const response = await request(instance.getHttpServer())
      .get("/health/ready")
      .expect(503);
    expect(response.body.checks.database).toBe("unavailable");
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(end).toHaveBeenCalled();
    await instance.close();
  });
  it("missing temporary directory degrades readiness", async () => {
    await fs.rmdir(path.join(root, ".tmp"));
    const instance = await app();
    const response = await request(instance.getHttpServer())
      .get("/health/ready")
      .expect(503);
    expect(response.body.checks.storage).toBe("unavailable");
    await instance.close();
  });
  it("coalesces concurrent checks and caches briefly", async () => {
    const instance = await app();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(instance.getHttpServer()).get("/health/ready").expect(200),
      ),
    );
    expect(connect).toHaveBeenCalledTimes(1);
    await instance.close();
  });
  it.each(["missing", "file", "read-only"])(
    "rejects unusable root: %s",
    async (mode) => {
      await fs.rm(root, { recursive: true });
      if (mode === "file") await fs.writeFile(root, "private content");
      if (mode === "read-only") {
        await fs.mkdir(root);
        await fs.chmod(root, 0o555);
      }
      const instance = await app();
      try {
        const response = await request(instance.getHttpServer())
          .get("/health/ready")
          .expect(503);
        expect(response.body.checks.storage).toBe("unavailable");
        expect(JSON.stringify(response.body)).not.toContain(root);
      } finally {
        await instance.close();
        if (mode === "read-only") await fs.chmod(root, 0o755);
      }
    },
  );
  it("returns within deadline while retaining one stalled probe for later callers", async () => {
    let release!: () => void;
    connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const instance = await app();
    const controller = instance.get(HealthController);
    jest.useFakeTimers();
    try {
      const first = controller.ready().catch((error) => error);
      await jest.advanceTimersByTimeAsync(3001);
      expect(await first).toMatchObject({ status: 503 });
      const second = controller.ready().catch((error) => error);
      await jest.advanceTimersByTimeAsync(3001);
      expect(await second).toMatchObject({ status: 503 });
      expect(connect).toHaveBeenCalledTimes(1);
      release();
    } finally {
      jest.useRealTimers();
      await instance.close();
    }
  });
});
