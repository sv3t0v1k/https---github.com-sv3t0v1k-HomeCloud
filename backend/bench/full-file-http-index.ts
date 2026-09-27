import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { monitorEventLoopDelay } from "perf_hooks";
import { spawn } from "child_process";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pipeline } from "stream/promises";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter";
import { LoggingInterceptor } from "../src/common/interceptors/logging.interceptor";
import { TransformInterceptor } from "../src/common/interceptors/transform.interceptor";
import { applySecurityMiddleware } from "../src/common/security.config";
import { validateStartupConfiguration } from "../src/common/startup-validation.service";
import { FileEntity } from "../src/entities/file.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { collectMemorySafetyEvidence } from "./multipart-memory";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Не задана ${name}`);
  return v;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function child(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [path.join(__dirname, "full-file-http-client.js")],
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
async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}
function safety(fileBytes: number, chunkBytes: number, storagePath: string) {
  const memory = collectMemorySafetyEvidence();
  const memoryEstimateBytes = chunkBytes * 4;
  const memoryUsableBytes = Math.max(
    0,
    memory.hostAvailableBytes - memory.hostReserveBytes,
  );
  const disk = fs.statfsSync(path.dirname(storagePath));
  const diskFreeBytes = disk.bavail * disk.bsize;
  const diskReserveBytes = 2 * 1024 ** 3;
  const diskEstimateBytes =
    fileBytes * 2 + chunkBytes + Math.ceil(fileBytes * 0.25) + 64 * 1024 ** 2;
  const pass =
    memoryEstimateBytes <= memoryUsableBytes &&
    diskEstimateBytes <= Math.max(0, diskFreeBytes - diskReserveBytes);
  const result = {
    pass,
    memory,
    memoryEstimateBytes,
    memoryUsableBytes,
    diskFreeBytes,
    diskReserveBytes,
    diskEstimateBytes,
    model: {
      generatedSourceBytes: 0,
      stagingBytes: fileBytes,
      finalBytes: fileBytes,
      transientIngressBytes: chunkBytes,
      dbWalLogTempMarginBytes: Math.ceil(fileBytes * 0.25) + 64 * 1024 ** 2,
    },
  };
  if (!pass) throw new Error(`NOT_RUN_SAFETY: ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const databaseUrl = required("HOMECLOUD_FULL_FILE_DATABASE_URL");
  const storagePath = required("HOMECLOUD_FULL_FILE_STORAGE_PATH");
  const confirm = required("HOMECLOUD_FULL_FILE_CONFIRM");
  const fileMiB = Number(required("BENCH_FILE_MIB"));
  const canonicalTempRoot = fs.realpathSync(os.tmpdir());
  const canonicalStorageParent = fs.realpathSync(path.dirname(storagePath));
  if (
    ![200, 500, 30 * 1024].includes(fileMiB) ||
    confirm !== "YES_ISOLATED_FULL_FILE" ||
    (canonicalStorageParent !== canonicalTempRoot &&
      !canonicalStorageParent.startsWith(canonicalTempRoot + path.sep)) ||
    !path.basename(storagePath).startsWith("homecloud-full-file-")
  )
    throw new Error("Небезопасная isolated-конфигурация");
  const db = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(db.hostname) ||
    db.pathname !== "/homecloud_full_file"
  )
    throw new Error("Разрешена только выделенная loopback БД");
  const fileBytes = fileMiB * 1024 * 1024,
    chunkBytes = 50 * 1024 * 1024;
  const gate = safety(fileBytes, chunkBytes, storagePath);
  const port = Number(process.env.BENCH_PORT ?? "30126");
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    STORAGE_PATH: storagePath,
    PORT: String(port),
    NODE_ENV: "production",
    MAX_CHUNK_SIZE: String(chunkBytes),
    MAX_FILE_SIZE: String(fileBytes),
    MAX_TOTAL_SIZE: String(fileBytes * 2),
    DB_PASSWORD: required("HOMECLOUD_FULL_FILE_DB_PASSWORD"),
    REDIS_PASSWORD: required("HOMECLOUD_FULL_FILE_REDIS_PASSWORD"),
    REDIS_URL: required("HOMECLOUD_FULL_FILE_REDIS_URL"),
    JWT_SECRET: required("HOMECLOUD_FULL_FILE_JWT_SECRET"),
    JWT_REFRESH_SECRET: required("HOMECLOUD_FULL_FILE_JWT_REFRESH_SECRET"),
  });
  fs.mkdirSync(storagePath, { recursive: false });
  fs.writeFileSync(
    path.join(storagePath, ".homecloud-full-file-owned"),
    confirm,
    { flag: "wx" },
  );
  const { AppModule } = await import("../src/app.module");
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
  });
  let phase = "warmup",
    chunkIndex: number | null = null;
  const points: Array<
    NodeJS.MemoryUsage & {
      atMs: number;
      phase: string;
      chunkIndex: number | null;
    }
  > = [];
  const drift: Array<{
    atMs: number;
    driftMs: number;
    phase: string;
    chunkIndex: number | null;
  }> = [];
  let loop: ReturnType<typeof monitorEventLoopDelay> | undefined;
  const started = performance.now();
  const capture = () =>
    points.push({
      ...process.memoryUsage(),
      atMs: performance.now() - started,
      phase,
      chunkIndex,
    });
  let expectedTick = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    capture();
    drift.push({
      atMs: now - started,
      driftMs: Math.max(0, now - expectedTick),
      phase,
      chunkIndex,
    });
    expectedTick = now + 10;
  }, 10);
  timer.unref();
  app.use(
    (
      req: {
        method: string;
        path: string;
        headers: Record<string, string | string[] | undefined>;
      },
      res: { once: (e: string, f: () => void) => void },
      next: () => void,
    ) => {
      if (req.method === "POST" && req.path === "/api/v1/uploads/session") {
        res.once("finish", () => {
          phase = "upload-baseline";
          chunkIndex = null;
          points.length = 0;
          drift.length = 0;
          expectedTick = performance.now() + 10;
          loop?.reset();
          capture();
        });
      }
      if (req.method === "POST" && /\/chunk$/.test(req.path)) {
        phase = "chunk";
        chunkIndex = Number(req.headers["x-benchmark-chunk-index"]);
      }
      if (req.method === "POST" && /\/complete$/.test(req.path)) {
        phase = "complete";
        chunkIndex = null;
      }
      if (req.method === "GET" && /\/files\/\d+\/download$/.test(req.path)) {
        phase = req.headers.range ? "download-range" : "download-full";
        chunkIndex = null;
      }
      res.once("finish", () => {
        capture();
        if (phase === "chunk") {
          phase = "between-chunks";
        }
      });
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
  try {
    await validateStartupConfiguration(app);
    applySecurityMiddleware(app, app.get(ConfigService));
    await app.listen(port, "127.0.0.1");
    const source = app.get(DataSource);
    const runId = crypto.randomBytes(6).toString("hex");
    const email = `full-file-${runId}@homecloud.local`;
    const password = `Full-file-${runId}-password`;
    const user = await source.getRepository(UserEntity).save({
      email,
      password: await bcrypt.hash(password, 12),
      name: "Full file bench",
      storageQuota: fileBytes * 2,
      storageUsed: 0,
    });
    await fetch(`http://127.0.0.1:${port}/api/v1/health`).catch(
      () => undefined,
    );
    await sleep(100);
    capture();
    loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    phase = "pre-upload";
    const client = JSON.parse(
      await child({
        ...process.env,
        BENCH_BASE_URL: `http://127.0.0.1:${port}`,
        BENCH_EMAIL: email,
        BENCH_PASSWORD: password,
        BENCH_FILE_BYTES: String(fileBytes),
        BENCH_CHUNK_BYTES: String(chunkBytes),
        BENCH_MIN_CHUNK_INTERVAL_MS: fileMiB === 30 * 1024 ? "700" : "0",
      }),
    );
    phase = "settle-immediate";
    capture();
    const immediate = process.memoryUsage();
    await sleep(5000);
    phase = "settle-5s";
    capture();
    const after5s = process.memoryUsage();
    await sleep(10000);
    phase = "settle-15s";
    capture();
    const after15s = process.memoryUsage();
    loop.disable();
    clearInterval(timer);
    const files = await source
      .getRepository(FileEntity)
      .findBy({ userId: user.id });
    const session = await source
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({ userId: user.id, uploadId: client.uploadId });
    const refreshed = await source
      .getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });
    const file = files[0];
    const actualSha256 = file ? await hashFile(file.storagePath) : null;
    const tmpPath = session.tempPath;
    const tempRoot = path.join(storagePath, ".tmp");
    const ingressRoot = path.join(tempRoot, "multipart-ingress");
    const tempTopEntriesBeforeCleanup = fs.existsSync(tempRoot)
      ? fs.readdirSync(tempRoot)
      : [];
    const ingressEntriesBeforeCleanup = fs.existsSync(ingressRoot)
      ? fs.readdirSync(ingressRoot)
      : [];
    const unexpectedTempEntriesBeforeCleanup =
      tempTopEntriesBeforeCleanup.filter(
        (entry) => entry !== "multipart-ingress",
      );
    const verification = {
      fileRows: files.length,
      dbSize: Number(file?.size),
      actualBytes: file ? fs.statSync(file.storagePath).size : null,
      expectedBytes: fileBytes,
      expectedSha256: client.expectedSha256,
      actualSha256,
      storageUsed: Number(refreshed.storageUsed),
      storageQuota: Number(refreshed.storageQuota),
      sessionStatus: session.status,
      uploadedSize: session.uploadedSize,
      uploadedChunks: session.uploadedChunks,
      sessionTempExistsBeforeCleanup: fs.existsSync(tmpPath),
      tempTopEntriesBeforeCleanup,
      ingressEntriesBeforeCleanup,
      unexpectedTempEntriesBeforeCleanup,
    };
    const ok =
      files.length === 1 &&
      verification.dbSize === fileBytes &&
      verification.actualBytes === fileBytes &&
      actualSha256 === client.expectedSha256 &&
      verification.storageUsed === fileBytes &&
      session.status === "completed" &&
      session.uploadedSize === fileBytes &&
      session.uploadedChunks.length === Math.ceil(fileBytes / chunkBytes) &&
      client.fullDownload.status === 200 &&
      client.fullDownload.bytes === fileBytes &&
      client.fullDownload.sha256 === client.expectedSha256 &&
      client.lateRange.status === 206 &&
      !verification.sessionTempExistsBeforeCleanup &&
      ingressEntriesBeforeCleanup.length === 0 &&
      unexpectedTempEntriesBeforeCleanup.length === 0;
    if (file?.storagePath) fs.unlinkSync(file.storagePath);
    await source.getRepository(UserEntity).delete(user.id);
    fs.rmSync(path.join(storagePath, String(user.id)), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(storagePath, ".tmp"), { recursive: true, force: true });
    const dbResiduals = {
      users: await source.getRepository(UserEntity).count(),
      files: await source.getRepository(FileEntity).count(),
      sessions: await source.getRepository(UploadSessionEntity).count(),
    };
    const fsResiduals = fs
      .readdirSync(storagePath)
      .filter((v) => v !== ".homecloud-full-file-owned");
    const peak = (key: keyof NodeJS.MemoryUsage) =>
      Math.max(...points.map((p) => p[key]));
    process.stdout.write(
      `${JSON.stringify(
        {
          runId,
          target: {
            fileMiB,
            fileBytes,
            chunkBytes,
            totalChunks: Math.ceil(fileBytes / chunkBytes),
          },
          safety: gate,
          provenance: {
            backendPid: process.pid,
            clientProcessIsolated: true,
            samplingIntervalMs: 10,
            monitorResetAfterWarmup: true,
          },
          client,
          memory: {
            baseline: points[0],
            peak: {
              rss: peak("rss"),
              heapUsed: peak("heapUsed"),
              external: peak("external"),
              arrayBuffers: peak("arrayBuffers"),
            },
            points,
            immediate,
            after5s,
            after15s,
          },
          eventLoop: {
            window: "post-session-through-authenticated-retrieval",
            p50Ms: loop.percentile(50) / 1e6,
            p95Ms: loop.percentile(95) / 1e6,
            p99Ms: loop.percentile(99) / 1e6,
            maxMs: loop.max / 1e6,
            drift,
          },
          verification,
          cleanup: { dbResiduals, fsResiduals },
        },
        null,
        2,
      )}\n`,
    );
    if (!ok || Object.values(dbResiduals).some(Boolean) || fsResiduals.length)
      throw new Error("Непригодный результат correctness/cleanup");
  } finally {
    clearInterval(timer);
    await app.close().catch(() => undefined);
    if (fs.existsSync(path.join(storagePath, ".homecloud-full-file-owned")))
      fs.rmSync(storagePath, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
