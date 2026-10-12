/* Explicit disposable Docker fixture only. No production activation. */
"use strict";
require("reflect-metadata");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { DataSource } = require("typeorm");

if (process.env.HOMECLOUD_SSD_API_FIXTURE !== "1")
  throw new Error("Explicit SSD API fixture opt-in required");
if (process.platform !== "linux" || process.getuid() !== 1001)
  throw new Error("Disposable nonroot Linux fixture required");
const originalUrl = new URL(process.env.DATABASE_URL);
if (
  originalUrl.hostname !== "homecloud-stage24-db" ||
  originalUrl.pathname !== "/stage24"
)
  throw new Error("Isolated stage24 database required");
if (
  process.env.STORAGE_PATH !== "/storage" ||
  process.env.UPLOAD_SSD_PATH !== "/ssd"
)
  throw new Error("Exact disposable fixture roots required");

const schema = "ssd_api_" + randomUUID().replace(/-/g, "");
const evidence = {
  schema,
  fixture: "disposable-docker",
  checks: [],
  success: false,
  limitations: [
    "Linux Docker VM filesystems, not physical SSD/HDD qualification",
    "Small payloads; 50+ GiB and power loss not qualified",
  ],
};
const resultPath = "/tmp/ssd-api-e2e.json";
let admin, app, query, base, token, userId;
let disconnectFixture;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function record(name, detail = {}) {
  evidence.checks.push({ name, pass: true, ...detail });
}
function save() {
  fs.writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + "\n");
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Fixture event timeout: ${label}`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function boot(enabled, recovery = "manual") {
  process.env.UPLOAD_SSD_ENABLED = enabled ? "true" : "false";
  process.env.UPLOAD_SSD_RECOVERY_MODE = recovery;
  // ConfigModule.validate captures env when the AppModule decorator runs.
  delete require.cache[require.resolve("../dist/app.module")];
  const { AppModule } = require("../dist/app.module");
  const { NestFactory } = require("@nestjs/core");
  const { ValidationPipe } = require("@nestjs/common");
  const { ConfigService } = require("@nestjs/config");
  const { JwtService } = require("@nestjs/jwt");
  const {
    HttpExceptionFilter,
  } = require("../dist/common/errors/http-exception.filter");
  const {
    TransformInterceptor,
  } = require("../dist/common/interceptors/transform.interceptor");
  const {
    structuredLogger,
  } = require("../dist/common/observability/structured-logger");
  const {
    requestObservability,
  } = require("../dist/common/observability/request-observability");
  const {
    MetricsService,
  } = require("../dist/common/observability/metrics.service");
  const { applySecurityMiddleware } = require("../dist/common/security.config");
  const { configureTrustedProxy } = require("../dist/common/trusted-proxy");
  const {
    validateStartupConfiguration,
  } = require("../dist/common/startup-validation.service");
  const {
    UploadRateLimitService,
  } = require("../dist/uploads/upload-rate-limit");
  app = await NestFactory.create(AppModule, {
    logger: structuredLogger,
    bodyParser: false,
    abortOnError: false,
  });
  await validateStartupConfiguration(app);
  const config = app.get(ConfigService);
  assert.equal(
    String(config.get("UPLOAD_SSD_ENABLED")),
    String(enabled),
    "Current boot flag must match fixture",
  );
  configureTrustedProxy(app, config);
  app.use(requestObservability(app.get(MetricsService)));
  applySecurityMiddleware(app, config, {
    jwtService: app.get(JwtService),
    uploads: app.get(UploadRateLimitService),
  });
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });
  // Passive fixture event observer: it neither handles nor changes requests.
  app.use((req, res, next) => {
    const observer = disconnectFixture;
    if (observer && req.url === observer.route)
      res.once("close", () => observer.closed.resolve(!res.writableFinished));
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()) + "/api/v1";
  const db = app.get(DataSource);
  query = (sql, params = []) => db.query(sql, params);
  assert.equal(
    (await query("SELECT current_schema() schema"))[0].schema,
    schema,
    "App must use only fixture schema",
  );
}

async function request(
  method,
  route,
  expected,
  body,
  extraHeaders = {},
  binary = false,
) {
  const headers = {
    ...(token ? { Authorization: "Bearer " + token } : {}),
    ...extraHeaders,
  };
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(base + route, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let safeFailureMessage = "";
  if (response.status !== expected && route.startsWith("/uploads/")) {
    try {
      const message = JSON.parse(bytes.toString("utf8")).message;
      if (typeof message === "string")
        safeFailureMessage =
          ": " + message.replace(/[\r\n]/g, " ").slice(0, 160);
    } catch {
      /* No raw body or authentication response is ever emitted. */
    }
  }
  assert.equal(
    response.status,
    expected,
    `${method} ${route} status${safeFailureMessage}`,
  );
  if (binary) return { bytes, headers: response.headers };
  const json = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  return json.success ? json.data : json;
}
async function create(
  name,
  data,
  digest = sha256(data),
  chunkSize = data.length,
) {
  return request("POST", "/uploads/session", 201, {
    filename: name,
    totalSize: data.length,
    chunkSize,
    ...(digest === undefined ? {} : { expectedSha256: digest }),
  });
}
async function chunk(session, bytes, index = 0) {
  const form = new FormData();
  form.set("chunkIndex", String(index));
  form.set(
    "chunk",
    new Blob([bytes], { type: "application/octet-stream" }),
    "part.bin",
  );
  return request(
    "POST",
    `/uploads/session/${session.uploadId}/chunk`,
    200,
    form,
  );
}
const complete = (session, status = 200) =>
  request("POST", `/uploads/session/${session.uploadId}/complete`, status);
const cancel = (session, status = 200) =>
  request("DELETE", `/uploads/session/${session.uploadId}`, status);
async function sessionRow(session) {
  return (
    await query(
      `SELECT * FROM upload_sessions WHERE "uploadId"=$1 AND "userId"=$2`,
      [session.uploadId, userId],
    )
  )[0];
}
async function quota() {
  return BigInt(
    (await query(`SELECT "storageUsed" FROM users WHERE id=$1`, [userId]))[0]
      .storageUsed,
  );
}
async function receipt(session) {
  return (
    await query(
      `SELECT * FROM ssd_finalization_operations WHERE "uploadId"=$1 AND "userId"=$2`,
      [session.uploadId, userId],
    )
  )[0];
}
async function oneFile(session, file, bytes, priorQuota) {
  assert.equal(
    (
      await query(
        `SELECT count(*)::int count FROM files WHERE "uploadId"=$1 AND "userId"=$2`,
        [session.uploadId, userId],
      )
    )[0].count,
    1,
  );
  assert.equal(await quota(), priorQuota + BigInt(bytes.length));
  assert.equal((await complete(session)).id, file.id);
  assert.equal(await quota(), priorQuota + BigInt(bytes.length));
  const download = await request(
    "GET",
    `/files/${file.id}/download`,
    200,
    undefined,
    {},
    true,
  );
  assert.deepEqual(download.bytes, bytes);
  const range = await request(
    "GET",
    `/files/${file.id}/download`,
    206,
    undefined,
    { Range: "bytes=1-3" },
    true,
  );
  assert.deepEqual(range.bytes, bytes.subarray(1, 4));
  assert.equal(range.headers.get("content-range"), `bytes 1-3/${bytes.length}`);
  assert.equal((await receipt(session)).cleanupState, "cleaned");
}

async function run() {
  // Credentials are ephemeral and never included in evidence or logs.
  process.env.NODE_ENV = "test";
  process.env.DB_PASSWORD = decodeURIComponent(originalUrl.password);
  process.env.REDIS_PASSWORD = randomBytes(24).toString("hex");
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString("hex");
  process.env.UPLOAD_SSD_MOUNT_SOURCE = "/dev/vda1";
  process.env.UPLOAD_SSD_MOUNT_ROOT =
    "/docker/volumes/homecloud-stage24-ssd/_data";
  process.env.UPLOAD_SSD_FS_TYPE = "ext4";
  process.env.MAX_CHUNK_SIZE = "1048576";
  process.env.MAX_FILE_SIZE = "10485760";
  process.env.MAX_TOTAL_SIZE = "104857600";
  const { markerContents } = require("../dist/storage/storage-mount-registry");
  const {
    SSD_UPLOAD_WORKSPACE,
    LEGACY_UPLOAD_WORKSPACE_ID,
  } = require("../dist/entities/upload-workspace.entity");
  const marker = path.join("/ssd", ".homecloud-storage-identity");
  const expectedMarker = markerContents(SSD_UPLOAD_WORKSPACE);
  if (!fs.existsSync(marker)) {
    const fd = fs.openSync(
      marker,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, expectedMarker);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const dir = fs.openSync(
      "/ssd",
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
  assert.equal(
    fs.readFileSync(marker, "utf8"),
    expectedMarker,
    "Fixture SSD enrollment must be exact",
  );
  assert.notEqual(
    fs.statSync("/storage").dev,
    fs.statSync("/ssd").dev,
    "Real container filesystem devices must differ",
  );
  evidence.devices = {
    hdd: String(fs.statSync("/storage").dev),
    ssd: String(fs.statSync("/ssd").dev),
  };

  admin = new DataSource({ type: "postgres", url: originalUrl.toString() });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const fixtureUrl = new URL(originalUrl);
  fixtureUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = fixtureUrl.toString();
  const migrations = require("../dist/data-source").default;
  migrations.setOptions({
    schema,
    extra: { options: `-c search_path=${schema}` },
  });
  await migrations.initialize();
  await migrations.runMigrations();
  await migrations.destroy();
  record("fresh-schema-migrations");

  await boot(false);
  await request("GET", "/uploads/sessions", 401);
  const email = `${schema}@example.test`;
  const password = randomBytes(16).toString("hex");
  const auth = await request("POST", "/auth/register", 201, {
    email,
    password,
    name: "SSD API Fixture",
  });
  token = auth.accessToken;
  assert.equal(typeof token, "string", "Register must issue access token");
  userId = (await query(`SELECT id FROM users WHERE email=$1`, [email]))[0].id;
  await query(`UPDATE users SET "storageQuota"=$2 WHERE id=$1`, [
    userId,
    "1073741824",
  ]);
  record("fixture-owned-account-quota-provisioned", {
    storageQuota: 1073741824,
  });
  const legacyBytes = Buffer.from("legacy-before-ssd");
  const legacyPart = Math.ceil(legacyBytes.length / 2);
  const legacy = await request("POST", "/uploads/session", 201, {
    filename: "legacy.txt",
    totalSize: legacyBytes.length,
    chunkSize: legacyPart,
  });
  await chunk(legacy, legacyBytes.subarray(0, legacyPart));
  assert.equal(
    (await sessionRow(legacy)).workspaceId,
    LEGACY_UPLOAD_WORKSPACE_ID,
  );
  assert.equal((await sessionRow(legacy)).expectedSha256, null);
  record("flag-off-legacy-session-partial-upload", { userId });
  await app.close();
  app = undefined;

  await boot(true);
  await chunk(legacy, legacyBytes.subarray(legacyPart), 1);
  const legacyFile = await complete(legacy);
  assert.deepEqual(
    (
      await request(
        "GET",
        `/files/${legacyFile.id}/download`,
        200,
        undefined,
        {},
        true,
      )
    ).bytes,
    legacyBytes,
  );
  record("legacy-session-completes-and-downloads-after-flag-on", {
    fileId: legacyFile.id,
  });

  await request("POST", "/uploads/session", 400, {
    filename: "missing.txt",
    totalSize: 4,
    chunkSize: 4,
  });
  await request("POST", "/uploads/session", 400, {
    filename: "invalid.txt",
    totalSize: 4,
    chunkSize: 4,
    expectedSha256: "A".repeat(64),
  });
  record("ssd-admission-missing-invalid-hash-400");
  const text = Buffer.from("SSD complete plaintext\n");
  const session = await create("ssd.txt", text);
  assert.equal(
    (await sessionRow(session)).workspaceId,
    SSD_UPLOAD_WORKSPACE.id,
  );
  const prior = await quota();
  await chunk(session, text);
  await chunk(session, text);
  assert.equal((await sessionRow(session)).uploadedCount, 1);
  const file = await complete(session);
  assert.equal(file.mimeType, "text/plain");
  await oneFile(session, file, text, prior);
  const preview = await request("GET", `/previews/${file.id}`, 200);
  assert.equal(preview.type, "text");
  assert.equal(preview.content, text.toString());
  record(
    "ssd-text-multipart-duplicate-complete-repeat-quota-download-range-preview",
    { fileId: file.id },
  );

  const png = await require("sharp")({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 37, g: 83, b: 119, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const imageSession = await create("actual.png", png);
  const beforeImage = await quota();
  await chunk(imageSession, png);
  const imageFile = await complete(imageSession);
  assert.equal(imageFile.mimeType, "image/png");
  await oneFile(imageSession, imageFile, png, beforeImage);
  assert.equal(
    (await request("GET", `/previews/${imageFile.id}`, 200)).type,
    "image",
  );
  const thumb = await request(
    "GET",
    `/previews/${imageFile.id}/thumbnail`,
    200,
    undefined,
    {},
    true,
  );
  assert.equal(thumb.headers.get("content-type"), "image/png");
  assert.ok(thumb.bytes.length > 8);
  record("actual-png-file-type-preview-thumbnail", { fileId: imageFile.id });

  const { SsdUploadsService } = require("../dist/uploads/ssd-uploads.service");
  const ssd = app.get(SsdUploadsService);
  const cancelled = await create("cancel.bin", Buffer.from("cancel-me"));
  await chunk(cancelled, Buffer.from("cancel-me"));
  const cancelRow = await sessionRow(cancelled);
  const unknown = path.join(cancelRow.tempPath, "fixture-unknown-artifact");
  fs.writeFileSync(unknown, "preserve-cancel", { flag: "wx", mode: 0o600 });
  await cancel(cancelled);
  await cancel(cancelled);
  assert.equal((await sessionRow(cancelled)).status, "aborted");
  assert.equal(fs.readFileSync(unknown, "utf8"), "preserve-cancel");
  assert.equal(fs.existsSync(path.join(cancelRow.tempPath, "0")), false);
  record("cancel-idempotent-owned-chunk-cleanup-unknown-preserved");
  const expired = await create("expired.bin", Buffer.from("expiry"));
  await chunk(expired, Buffer.from("expiry"));
  const expiredRow = await sessionRow(expired);
  const expiryUnknown = path.join(
    expiredRow.tempPath,
    "fixture-unknown-artifact",
  );
  fs.writeFileSync(expiryUnknown, "preserve-expiry", {
    flag: "wx",
    mode: 0o600,
  });
  await query(
    `UPDATE upload_sessions SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`,
    [expiredRow.id],
  );
  assert.equal(await ssd.cleanupExpiredSessions(), 1);
  assert.equal((await sessionRow(expired)).status, "aborted");
  assert.equal(fs.readFileSync(expiryUnknown, "utf8"), "preserve-expiry");
  record("expiry-service-uses-owned-cleanup-unknown-preserved", {
    trigger: "real service cleanup entrypoint",
  });

  async function assertCapacityBackpressure(scarceRoot, name) {
    const statfs = fs.statfsSync;
    let pressureBranchEvaluated = false;
    const beforeSessions = (
      await query("SELECT count(*)::int count FROM upload_sessions")
    )[0].count;
    fs.statfsSync = function (target, options) {
      const stats = statfs.call(fs, target, options);
      if (options && options.bigint && target === scarceRoot) {
        pressureBranchEvaluated = true;
        return { ...stats, bavail: 0n };
      }
      return stats;
    };
    try {
      await request("POST", "/uploads/session", 503, {
        filename: `${name}-no-capacity.bin`,
        totalSize: 4,
        chunkSize: 4,
        expectedSha256: sha256(Buffer.from("full")),
      });
    } finally {
      fs.statfsSync = statfs;
    }
    assert.equal(
      pressureBranchEvaluated,
      true,
      "Requested pressure branch must actually run",
    );
    assert.equal(
      (await query("SELECT count(*)::int count FROM upload_sessions"))[0].count,
      beforeSessions,
    );
    record(`${name}-capacity-backpressure-503`, {
      fault: "bounded statfs available-blocks injection",
      scarceRoot,
      otherRoot: "real available capacity unchanged",
      newSessions: 0,
      pressureBranchEvaluated,
    });
  }
  await assertCapacityBackpressure("/ssd", "ssd");
  await assertCapacityBackpressure("/storage", "hdd");

  const {
    PostgresSsdFinalizationStore,
  } = require("../dist/uploads/ssd-finalization-store");
  const store = app.get(PostgresSsdFinalizationStore);
  const lostBytes = Buffer.from("durable-commit-response-loss");
  const lost = await create("lost-response.txt", lostBytes);
  const beforeLost = await quota();
  await chunk(lost, lostBytes);
  const commit = store.commit.bind(store);
  let faults = 0;
  store.commit = async function (id) {
    const value = await commit(id);
    if (!faults++) throw new Error("fixture durable commit response loss");
    return value;
  };
  try {
    await complete(lost, 500);
  } finally {
    store.commit = commit;
  }
  assert.equal(faults, 1, "No commit retry loop");
  const lostFile = await complete(lost);
  await oneFile(lost, lostFile, lostBytes, beforeLost);
  record("commit-response-loss-500-repeat-200-one-file-one-quota", {
    fileId: lostFile.id,
  });

  const recoveryBytes = Buffer.from("startup-recovery-owned-bytes");
  const recovering = await create("restart.txt", recoveryBytes);
  const beforeRecovery = await quota();
  await chunk(recovering, recoveryBytes);
  const {
    IsolatedSsdFinalizationFilesystem,
  } = require("../dist/uploads/ssd-finalization-filesystem");
  const createTemporary =
    IsolatedSsdFinalizationFilesystem.prototype.createTemporary;
  IsolatedSsdFinalizationFilesystem.prototype.createTemporary = function () {
    throw new Error("fixture crash before target creation");
  };
  try {
    await complete(recovering, 500);
  } finally {
    IsolatedSsdFinalizationFilesystem.prototype.createTemporary =
      createTemporary;
  }
  assert.equal((await receipt(recovering)).state, "assembling");
  await cancel(recovering, 503);
  assert.ok(
    fs.existsSync(path.join((await sessionRow(recovering)).tempPath, "0")),
  );
  await app.close();
  app = undefined;
  await boot(true, "once");
  const startupReceipt = await receipt(recovering);
  assert.equal(
    startupReceipt.state,
    "committed",
    "Startup itself must recover before any complete API replay",
  );
  assert.equal(
    startupReceipt.cleanupState,
    "cleaned",
    "Startup itself must clean before any complete API replay",
  );
  const recovered = await complete(recovering);
  await oneFile(recovering, recovered, recoveryBytes, beforeRecovery);
  record("startup-recovery-once-assembling-cancel-fenced-one-file-one-quota", {
    fileId: recovered.id,
  });

  const disconnectBytes = Buffer.from("disconnect-held-ingress-fence");
  const disconnectedSession = await create("disconnected.txt", disconnectBytes);
  const beforeDisconnect = await quota();
  const liveSsd = app.get(SsdUploadsService);
  const digest = liveSsd.digest;
  const uploadChunk = liveSsd.uploadChunk;
  const entered = deferred(),
    resume = deferred(),
    digestSettled = deferred(),
    handlerSettled = deferred(),
    serverClosed = deferred();
  let paused = false;
  liveSsd.digest = async function (...args) {
    if (!paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
      try {
        return await digest.apply(this, args);
      } finally {
        digestSettled.resolve();
      }
    }
    return digest.apply(this, args);
  };
  liveSsd.uploadChunk = async function (...args) {
    try {
      return await uploadChunk.apply(this, args);
    } finally {
      if (args[1] === disconnectedSession.uploadId) handlerSettled.resolve();
    }
  };
  const controller = new AbortController();
  const form = new FormData();
  form.set("chunkIndex", "0");
  form.set(
    "chunk",
    new Blob([disconnectBytes], { type: "application/octet-stream" }),
    "part.bin",
  );
  const chunkRoute = `/uploads/session/${disconnectedSession.uploadId}/chunk`;
  disconnectFixture = { route: "/api/v1" + chunkRoute, closed: serverClosed };
  const clientResult = fetch(base + chunkRoute, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
    signal: controller.signal,
  }).then(
    (response) => ({ kind: "response", status: response.status }),
    (error) => ({ kind: "error", name: error.name }),
  );
  try {
    await bounded(entered.promise, "multipart entered owned digest");
    await cancel(disconnectedSession, 503);
    controller.abort();
    assert.deepEqual(await bounded(clientResult, "HTTP client aborted"), {
      kind: "error",
      name: "AbortError",
    });
    assert.equal(
      await bounded(
        serverClosed.promise,
        "server observed premature response close",
      ),
      true,
    );
    // This second refusal proves disconnection itself did not release ownership.
    await cancel(disconnectedSession, 503);
    resume.resolve();
    await bounded(digestSettled.promise, "owned digest settled");
    await bounded(handlerSettled.promise, "chunk handler released ownership");
    await cancel(disconnectedSession);
    const disconnectedRow = await sessionRow(disconnectedSession);
    assert.equal(disconnectedRow.status, "aborted");
    assert.equal(
      fs.existsSync(path.join(disconnectedRow.tempPath, "0")),
      false,
    );
    assert.equal(
      (
        await query(
          `SELECT count(*)::int count FROM upload_chunks WHERE "sessionId"=$1`,
          [disconnectedRow.id],
        )
      )[0].count,
      0,
    );
    assert.equal(
      (
        await query(
          `SELECT count(*)::int count FROM files WHERE "uploadId"=$1`,
          [disconnectedSession.uploadId],
        )
      )[0].count,
      0,
    );
    assert.equal(await quota(), beforeDisconnect);
    record("ingress-disconnect-keeps-fence-until-handler-settles", {
      beforeDisconnectCancel: 503,
      afterDisconnectCancel: 503,
      settledCancel: 200,
      addedQuota: 0,
      serverObservedDisconnect: true,
    });
  } finally {
    controller.abort();
    resume.resolve();
    await bounded(
      handlerSettled.promise,
      "disconnection fixture teardown",
    ).catch(() => {});
    liveSsd.digest = digest;
    liveSsd.uploadChunk = uploadChunk;
    disconnectFixture = undefined;
  }

  // Last: fail-closed mismatch intentionally retains the global finalization barrier.
  const mismatchBytes = Buffer.from("whole-checksum-mismatch");
  const mismatch = await create("mismatch.txt", mismatchBytes, "0".repeat(64));
  await chunk(mismatch, mismatchBytes);
  const beforeMismatch = await quota();
  await complete(mismatch, 500);
  const mismatchOp = await receipt(mismatch);
  assert.equal(mismatchOp.state, "assembling");
  assert.equal(mismatchOp.cleanupState, "pending");
  assert.equal(await quota(), beforeMismatch);
  assert.deepEqual(
    fs.readFileSync(path.join((await sessionRow(mismatch)).tempPath, "0")),
    mismatchBytes,
  );
  assert.deepEqual(
    fs.readFileSync(mismatchOp.binding.temporaryPath),
    mismatchBytes,
  );
  await cancel(mismatch, 503);
  record("whole-hash-mismatch-retains-ssd-hdd-artifacts-and-barrier", {
    operationId: mismatchOp.id,
  });
  evidence.retained = {
    pendingOperationId: mismatchOp.id,
    sourcePath: mismatchOp.binding.sourcePath,
    temporaryPath: mismatchOp.binding.temporaryPath,
  };
  evidence.summary = (
    await query(
      `SELECT (SELECT count(*) FROM files)::int files,(SELECT count(*) FROM upload_sessions)::int sessions,(SELECT count(*) FROM ssd_finalization_operations WHERE "cleanupState"='pending')::int pending`,
    )
  )[0];
  evidence.success = true;
  save();
  console.log(JSON.stringify(evidence));
}

run()
  .catch((error) => {
    evidence.failure = {
      name: error.name,
      message: String(error.message).replace(
        /postgres(?:ql)?:\/\/[^\s]+/g,
        "[database URL redacted]",
      ),
    };
    save();
    console.error(
      JSON.stringify({
        success: false,
        schema,
        completedChecks: evidence.checks.length,
        failure: evidence.failure,
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
    // Retain the owned schema and mismatch artifacts for root-agent inspection;
    // dispose the dedicated fixture container/volume and schema only after evidence capture.
    if (admin && admin.isInitialized) await admin.destroy();
  });
