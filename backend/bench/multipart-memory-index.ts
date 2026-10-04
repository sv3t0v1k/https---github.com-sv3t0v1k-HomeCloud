import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { spawn } from "child_process";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter";
import { LoggingInterceptor } from "../src/common/interceptors/logging.interceptor";
import { TransformInterceptor } from "../src/common/interceptors/transform.interceptor";
import { applySecurityMiddleware } from "../src/common/security.config";
import { validateStartupConfiguration } from "../src/common/startup-validation.service";
import { FileEntity } from "../src/entities/file.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { UserEntity } from "../src/entities/user.entity";
import {
  assertSafePlan,
  collectMemorySafetyEvidence,
  startBackendProbe,
  summarizeMemory,
} from "./multipart-memory";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Не задана ${name}`);
  return v;
}
function child(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [path.join(__dirname, "multipart-memory-client.js")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (v) => (out += v));
    p.stderr.on("data", (v) => (err += v));
    p.on("exit", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`Клиент завершился ${code}: ${err.slice(0, 1000)}`)),
    );
  });
}
async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const databaseUrl = required("HOMECLOUD_MULTIPART_DATABASE_URL");
  const storagePath = required("HOMECLOUD_MULTIPART_STORAGE_PATH");
  const confirm = required("HOMECLOUD_MULTIPART_CONFIRM");
  if (
    confirm !== "YES_ISOLATED_MULTIPART_MEMORY" ||
    !storagePath.startsWith(os.tmpdir()) ||
    !path.basename(storagePath).startsWith("homecloud-multipart-memory-")
  )
    throw new Error("Небезопасная isolated-конфигурация");
  const db = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(db.hostname) ||
    db.pathname !== "/homecloud_multipart_memory"
  )
    throw new Error("Разрешена только выделенная loopback БД");
  const chunkMiB = Number(process.env.BENCH_CHUNK_MIB ?? "25");
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? "1");
  const chunkBytes = chunkMiB * 1024 * 1024;
  const safetyEvidence = collectMemorySafetyEvidence();
  const safetyDecision = assertSafePlan(
    chunkBytes,
    concurrency,
    safetyEvidence,
  );
  const port = Number(process.env.BENCH_PORT ?? "30125");
  const runId = crypto.randomBytes(6).toString("hex");
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    STORAGE_PATH: storagePath,
    PORT: String(port),
    NODE_ENV: "production",
    ALLOWED_UPLOAD_MIME_TYPES: "application/octet-stream",
    MAX_CHUNK_SIZE: String(50 * 1024 * 1024),
    MAX_FILE_SIZE: String(1024 * 1024 * 1024),
    MAX_TOTAL_SIZE: String(10 * 1024 * 1024 * 1024),
    DB_PASSWORD: required("HOMECLOUD_MULTIPART_DB_PASSWORD"),
    REDIS_PASSWORD: required("HOMECLOUD_MULTIPART_REDIS_PASSWORD"),
    REDIS_URL: required("HOMECLOUD_MULTIPART_REDIS_URL"),
    JWT_SECRET: required("HOMECLOUD_MULTIPART_JWT_SECRET"),
    JWT_REFRESH_SECRET: required("HOMECLOUD_MULTIPART_JWT_REFRESH_SECRET"),
  });
  fs.mkdirSync(storagePath, { recursive: false });
  fs.writeFileSync(
    path.join(storagePath, ".homecloud-multipart-memory-owned"),
    confirm,
    { flag: "wx" },
  );
  const { AppModule } = await import("../src/app.module");
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
  });
  let probe: ReturnType<typeof startBackendProbe> | undefined;
  app.use(
    (
      req: { method: string; path: string },
      res: { once: (event: string, fn: () => void) => void },
      next: () => void,
    ) => {
      if (
        req.method === "POST" &&
        /^\/api\/v1\/uploads\/session\/[^/]+\/chunk$/.test(req.path)
      ) {
        const activeProbe = probe;
        if (!activeProbe) throw new Error("Backend probe не запущен");
        activeProbe.enter();
        let done = false;
        const leave = () => {
          if (!done) {
            done = true;
            activeProbe.leave();
          }
        };
        res.once("finish", leave);
        res.once("close", leave);
      }
      next();
    },
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(
    new TransformInterceptor(),
    new LoggingInterceptor(),
  );
  app.setGlobalPrefix("api/v1");
  let source: DataSource | undefined;
  try {
    await validateStartupConfiguration(app);
    applySecurityMiddleware(app, app.get(ConfigService));
    await app.listen(port, "127.0.0.1");
    const dataSource = app.get(DataSource);
    source = dataSource;
    for (let index = 0; index < concurrency; index += 1) {
      const email = `multipart-${runId}-${index}@homecloud.local`;
      const password = `Multipart-${runId}-${index}-password`;
      await dataSource.getRepository(UserEntity).save({
        email,
        password: await bcrypt.hash(password, 12),
        name: "Multipart bench",
        storageQuota: chunkBytes * 2,
        storageUsed: 0,
      });
    }
    const baseline = { ...process.memoryUsage(), atMs: 0, active: 0 };
    probe = startBackendProbe(10);
    const raw = await child({
      ...process.env,
      BENCH_BASE_URL: `http://127.0.0.1:${port}`,
      BENCH_CHUNK_BYTES: String(chunkBytes),
      BENCH_CONCURRENCY: String(concurrency),
      BENCH_RUN_ID: runId,
    });
    const client = JSON.parse(raw) as {
      sessions: Array<{ email: string; uploadId: string; sha256: string }>;
      results: unknown[];
    };
    probe.snapshot();
    const immediate = process.memoryUsage();
    await sleep(5000);
    probe.snapshot();
    const after5s = process.memoryUsage();
    await sleep(10000);
    probe.snapshot();
    const after15s = process.memoryUsage();
    const sampled = probe.finish();
    const verification = [];
    for (const item of client.sessions) {
      const user = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ email: item.email });
      const files = await dataSource
        .getRepository(FileEntity)
        .findBy({ userId: user.id });
      const file = files[0];
      const session = await dataSource
        .getRepository(UploadSessionEntity)
        .findOneByOrFail({ uploadId: item.uploadId, userId: user.id });
      const bytes = file ? fs.readFileSync(file.storagePath) : Buffer.alloc(0);
      verification.push({
        email: item.email,
        fileRows: files.length,
        size: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        expectedSha256: item.sha256,
        storageUsed: Number(user.storageUsed),
        storageQuota: Number(user.storageQuota),
        quotaWithinBounds:
          Number(user.storageQuota) === 0 ||
          Number(user.storageUsed) <= Number(user.storageQuota),
        sessionStatus: session.status,
        sessionUploadedSize: session.uploadedSize,
        sessionUploadedChunks: session.uploadedCount,
        ok:
          files.length === 1 &&
          file?.uploadId === item.uploadId &&
          bytes.length === chunkBytes &&
          Number(user.storageUsed) === chunkBytes &&
          (Number(user.storageQuota) === 0 ||
            Number(user.storageUsed) <= Number(user.storageQuota)) &&
          session.status === "completed" &&
          session.uploadedSize === chunkBytes &&
          session.uploadedCount === 1 &&
          crypto.createHash("sha256").update(bytes).digest("hex") ===
            item.sha256,
      });
      await dataSource.getRepository(UserEntity).delete(user.id);
      fs.rmSync(path.join(storagePath, String(user.id)), {
        recursive: true,
        force: true,
      });
    }
    const dbResiduals = {
      users: await dataSource.getRepository(UserEntity).count(),
      files: await dataSource.getRepository(FileEntity).count(),
      uploadSessions: await dataSource
        .getRepository(UploadSessionEntity)
        .count(),
    };
    fs.rmSync(path.join(storagePath, ".tmp"), {
      recursive: true,
      force: true,
    });
    const filesystemResiduals = fs
      .readdirSync(storagePath)
      .filter((name) => name !== ".homecloud-multipart-memory-owned");
    const result = {
      runId,
      target: { chunkMiB, concurrency },
      provenance: {
        pid: process.pid,
        kind: "backend-process-memoryUsage",
        clientPidIsolated: true,
        samplingIntervalMs: 10,
        forcedGc: false,
      },
      resources: {
        ...safetyEvidence,
        decision: safetyDecision,
      },
      overlap: {
        requested: concurrency,
        observedMaxActive: sampled.maxActive,
        finalActive: sampled.finalActive,
      },
      client: client.results,
      memory: {
        ...summarizeMemory(sampled.points, baseline),
        immediate,
        after5s,
        after15s,
      },
      eventLoop: sampled.eventLoop,
      verification,
      cleanup: {
        usersDeleted: verification.length,
        storageOwnedOnly: true,
        dbResiduals,
        filesystemResiduals,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      sampled.maxActive !== concurrency ||
      sampled.finalActive !== 0 ||
      verification.some((v) => !v.ok) ||
      Object.values(dbResiduals).some((count) => count !== 0) ||
      filesystemResiduals.length !== 0
    )
      throw new Error("Непригодный результат: overlap/correctness");
  } finally {
    if (source?.isInitialized) await app.close();
    else await app.close().catch(() => undefined);
    if (
      fs.existsSync(path.join(storagePath, ".homecloud-multipart-memory-owned"))
    )
      fs.rmSync(storagePath, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
