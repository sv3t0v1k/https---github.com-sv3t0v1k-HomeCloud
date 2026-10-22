import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { SsdUploadsService } from "./ssd-uploads.service";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadWorkspaceEntity, SSD_UPLOAD_WORKSPACE, LEGACY_UPLOAD_WORKSPACE_ID } from "../entities/upload-workspace.entity";
import { UserEntity } from "../entities/user.entity";
import { FileEntity } from "../entities/file.entity";
import { SsdCrossFsFinalizer } from "./ssd-cross-fs-finalizer";
import { SsdFinalizationRecovery } from "./ssd-finalization-recovery";

const mutableFs = jest.requireActual<typeof import("node:fs")>("node:fs");
// Portable service orchestration only. Native confinement/flock are verified by
// Linux Docker suites; this boundary exercises real bounded file I/O on scratch.
jest.mock("./prepared-ssd-workspace", () => ({
  PreparedSsdWorkspace: class {
    constructor(private readonly storage: any) {}
    root() { return this.storage.getPreparedSsdRoot(); }
    resolve(session: any) {
      if (session.workspaceId !== SSD_UPLOAD_WORKSPACE.id || session.tempPath !== path.join(this.root(), session.uploadId)) throw new Error("Invalid SSD binding");
      return session.tempPath;
    }
    filesystem() { return this.storage.boundary; }
    ingress() { return path.join(this.root(), "multipart-ingress"); }
    close = jest.fn();
  },
}));

describe("SSD upload service portable API orchestration", () => {
  let root: string, hdd: string;
  let db: any, storage: any, store: any, manager: any;
  let service: SsdUploadsService;
  let sessions: UploadSessionEntity[];
  let chunks: any[];
  let inTransaction: boolean;
  let reserved: boolean;
  let free: bigint;
  let quota: number;
  const bytes = Buffer.from("whole-file durable content");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const configuration = (values: Record<string, unknown> = {}) => ({ get: (key: string) => ({ UPLOAD_SSD_ENABLED: "true", MAX_CHUNK_SIZE: "128", ...values })[key] });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-ssd-service-"));
    hdd = fs.mkdtempSync(path.join(os.tmpdir(), "hc-hdd-service-"));
    sessions = []; chunks = []; inTransaction = false; reserved = false; free = 1000000n; quota = 1000000;
    const sessionRepository = {
      create: jest.fn((data: any) => ({ origin: "owner", ...data, id: sessions.length + 1, createdAt: new Date() })),
      save: jest.fn(async (session: UploadSessionEntity) => { if (!sessions.includes(session)) sessions.push(session); return session; }),
      findOneBy: jest.fn(async (criteria: any) => sessions.find((session) => Object.entries(criteria).every(([key, value]) => session[key as keyof UploadSessionEntity] === value)) ?? null),
      findOneByOrFail: jest.fn(async ({ id }: any) => sessions.find((session) => session.id === id)),
      update: jest.fn(async ({ id }: any, values: any) => Object.assign(sessions.find((session) => session.id === id)!, values)),
      find: jest.fn(async () => sessions),
    };
    const chunkRepository = {
      findOneBy: jest.fn(async ({ sessionId, chunkIndex }: any) => chunks.find((chunk) => chunk.sessionId === sessionId && chunk.chunkIndex === chunkIndex) ?? null),
      insert: jest.fn(async (chunk: any) => { chunks.push(chunk); }),
      find: jest.fn(async ({ where }: any) => chunks.filter((chunk) => chunk.sessionId === where.sessionId)),
      delete: jest.fn(async ({ sessionId, chunkIndex }: any) => { chunks = chunks.filter((chunk) => chunk.sessionId !== sessionId || chunk.chunkIndex !== chunkIndex); }),
    };
    const repository = (entity: any) => entity === UploadSessionEntity ? sessionRepository : entity === UploadChunkEntity ? chunkRepository : entity === UploadWorkspaceEntity ? { findOneBy: jest.fn(async () => SSD_UPLOAD_WORKSPACE) } : { findOneBy: jest.fn(async () => null) };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("current_setting")) return [{ fsync: "on", pages: "on" }];
      if (sql.includes("SET LOCAL")) return [];
      if (sql.includes("remaining")) return [{ remaining: sessions.filter((session) => session.status !== "aborted").reduce((sum, session) => sum + session.totalSize - session.uploadedSize, 0), hdd: sessions.filter((session) => session.status !== "aborted").reduce((sum, session) => sum + session.totalSize, 0) }];
      if (sql.includes("::text bytes")) return [{ bytes: sessions.filter((session) => ["pending", "uploading"].includes(session.status)).reduce((sum, session) => sum + session.totalSize, 0) }];
      if (sql.includes("ssd_finalization_operations")) return reserved ? [{ id: "existing-reservation" }] : [];
      return [];
    });
    manager = {
      query, getRepository: repository,
      findOne: jest.fn(async (entity: any, options: any) => entity === UserEntity ? { id: 7, storageQuota: quota, storageUsed: 0 } : sessionRepository.findOneBy(options.where)),
      create: jest.fn((_entity: any, data: any) => sessionRepository.create(data)),
      save: sessionRepository.save,
    };
    db = { query, manager, getRepository: repository, transaction: jest.fn(async (callback: any) => { inTransaction = true; try { return await callback(manager); } finally { inTransaction = false; } }) };
    const io = (callback: (...args: any[]) => any) => jest.fn((...args: any[]) => { expect(inTransaction).toBe(false); return callback(...args); });
    storage = {
      getPreparedSsdRoot: jest.fn(() => root), getStoragePath: jest.fn(() => hdd),
      assertPreparedSsdPath: jest.fn((target: string) => { if (!(target === root || target.startsWith(root + path.sep))) throw new Error("Invalid path"); return target; }),
      boundary: {
        open: io((target, mode = "r") => fs.openSync(target, mode === "rw" ? "r+" : mode)),
        stat: io((target) => fs.lstatSync(target)),
        mkdir: io((target) => fs.mkdirSync(target, { recursive: true, mode: 0o700 })),
        sync: io((target) => { const fd = fs.openSync(target, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }),
        rename: io((source, target) => fs.renameSync(source, target)),
        lock: jest.fn(),
        removeOwned: io((target, fd) => { const actual = fs.lstatSync(target), owned = fs.fstatSync(fd); if (actual.ino !== owned.ino || actual.dev !== owned.dev) throw new Error("Identity changed"); fs.unlinkSync(target); }),
      },
    };
    store = {};
    jest.spyOn(mutableFs, "statfsSync").mockImplementation(() => ({ bavail: free, bsize: 1n }) as fs.BigIntStatsFs);
    service = new SsdUploadsService(db, storage, configuration() as any, store);
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hdd, { recursive: true, force: true });
  });

  it("defaults OFF without opening SSD, querying journals or starting recovery", async () => {
    service = new SsdUploadsService(db, storage, { get: () => undefined } as any, store);
    expect(service.enabled).toBe(false);
    await service.onModuleInit();
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256)).rejects.toThrow("disabled");
    expect(storage.getPreparedSsdRoot).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(["1", "yes", "", "TRUE"])("rejects ambiguous feature flag %s", (value) => {
    expect(() => new SsdUploadsService(db, storage, configuration({ UPLOAD_SSD_ENABLED: value }) as any, store)).toThrow("must be true or false");
  });
  it("requires whole SHA256 before any SSD admission or DB reservation", async () => {
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length)).rejects.toThrow("whole-file SHA256");
    expect(storage.getPreparedSsdRoot).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("rejects a SHA256 with trailing newline before opening the filesystem", async () => {
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, `${expectedSha256}\n`)).rejects.toThrow("whole-file SHA256");
    expect(storage.getPreparedSsdRoot).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("uses durable short transactions and keeps SSD chunks separate from legacy", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    expect(session.workspaceId).toBe(SSD_UPLOAD_WORKSPACE.id);
    expect(session.expectedSha256).toBe(expectedSha256);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    expect(fs.readFileSync(path.join(session.tempPath, "0"))).toEqual(bytes);
    expect(chunks).toEqual([{ sessionId: session.id, chunkIndex: 0, byteSize: bytes.length, sha256: expectedSha256 }]);
    expect(db.query).toHaveBeenCalledWith("SET LOCAL synchronous_commit=on");
    session.workspaceId = LEGACY_UPLOAD_WORKSPACE_ID;
    await expect(service.getUploadSession(7, session.uploadId)).rejects.toThrow("not found");
  });
  it("reserves owner quota across active sessions", async () => {
    quota = bytes.length;
    await service.createUploadSession(7, "first.txt", bytes.length, bytes.length, undefined, expectedSha256);
    await expect(service.createUploadSession(7, "second.txt", bytes.length, bytes.length, undefined, expectedSha256)).rejects.toThrow("quota");
    expect(sessions).toHaveLength(1);
  });
  it("accepts a null parent as a root folder upload", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, null, expectedSha256);
    expect(session.parentId).toBeNull();
  });
  it("replays a cleaned committed upload and reconciles metadata during SSD outage without filesystem access", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    session.status = "completed";
    const file = { id: 91, userId: 7, uploadId: session.uploadId, name: "file.txt", size: bytes.length, mimeType: "text/plain", parentId: null };
    const originalRepository = db.getRepository;
    db.getRepository = jest.fn((entity) => entity === FileEntity ? { findOneBy: jest.fn(async () => file) } : originalRepository(entity));
    const originalQuery = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql: string, ...args: any[]) => sql.includes("ssd_finalization_operations") ? [{ id: "cleaned-receipt" }] : originalQuery(sql, ...args));
    store.lookup = jest.fn(async () => ({ operation: { cleanupState: "cleaned", state: "committed" }, file }));
    storage.getPreparedSsdRoot.mockClear();
    storage.getPreparedSsdRoot.mockImplementation(() => { throw new Error("SSD missing"); });
    const transactions = db.transaction.mock.calls.length;
    expect(await service.completeUpload(7, session.uploadId)).toBe(file);
    expect(await service.completeUpload(7, session.uploadId)).toBe(file);
    expect(await service.reconcileUploadSession(7, session.uploadId)).toMatchObject({ status: "completed", file: { id: 91 }, chunks: [] });
    expect(storage.getPreparedSsdRoot).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(transactions);
    expect(store.lookup).toHaveBeenCalledTimes(2);
    await expect(service.completeUpload(8, session.uploadId)).rejects.toThrow("not found");
    expect(store.lookup).toHaveBeenCalledTimes(2);
  });
  it("rejects capacity pressure and kernel busy immediately", async () => {
    free = 0n;
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256)).rejects.toThrow("capacity");
    expect(db.transaction).not.toHaveBeenCalled();
    free = 1000000n;
    storage.boundary.lock.mockImplementation(() => { throw new Error("busy"); });
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256)).rejects.toThrow("busy");
    expect(storage.boundary.lock).toHaveBeenCalledTimes(2);
  });
  it("holds one ingress flock through multipart chunk handling and rejects reused capability", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    const capability = await service.acquireIngress(7, session.uploadId);
    const target = path.join(capability.destination, "request.chunk");
    fs.writeFileSync(target, bytes);
    const locks = storage.boundary.lock.mock.calls.length;
    await service.uploadChunk(7, session.uploadId, 0, { path: target, size: bytes.length }, capability);
    expect(storage.boundary.lock).toHaveBeenCalledTimes(locks);
    capability.release();
    await expect(service.uploadChunk(7, session.uploadId, 0, bytes, capability)).rejects.toThrow("ownership");
    expect(fs.readFileSync(path.join(session.tempPath, "0"))).toEqual(bytes);
  });
  it("deduplicates identical chunks and rejects a changed duplicate", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    expect(chunks).toHaveLength(1);
    expect(session.uploadedCount).toBe(1);
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    await expect(service.uploadChunk(7, session.uploadId, 0, changed)).rejects.toThrow("different content");
    expect(fs.readFileSync(path.join(session.tempPath, "0"))).toEqual(bytes);
  });
  it("defers ingress release while hashing/commit continues after request teardown", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    const capability = await service.acquireIngress(7, session.uploadId);
    const target = path.join(capability.destination, "paused.chunk"); fs.writeFileSync(target, bytes);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let started!: () => void;
    const hashing = new Promise<void>((resolve) => { started = resolve; });
    const original = (service as any).digest.bind(service);
    jest.spyOn(service as any, "digest").mockImplementation(async (...args: any[]) => { started(); await paused; return original(...args); });
    const completion = service.uploadChunk(7, session.uploadId, 0, { path: target, size: bytes.length }, capability);
    await hashing;
    capability.release();
    expect((service as any).capabilities.has(capability)).toBe(true);
    await expect(service.uploadChunk(7, session.uploadId, 0, bytes, capability)).rejects.toThrow("ownership");
    resume();
    await completion;
    expect((service as any).capabilities.has(capability)).toBe(false);
    expect(session.uploadedCount).toBe(1);
  });
  it("refuses a database without fsync before creating SSD bytes or a session", async () => {
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql: string, ...args: any[]) => sql.includes("current_setting") ? [{ fsync: "off", pages: "on" }] : original(sql, ...args));
    await expect(service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256)).rejects.toThrow("Durable database");
    expect(sessions).toHaveLength(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("reserved finalization fences both chunks and cancellation", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    reserved = true;
    await expect(service.uploadChunk(7, session.uploadId, 0, bytes)).rejects.toThrow("reserved");
    await expect(service.abortUpload(7, session.uploadId)).rejects.toThrow("reserved");
    expect(session.status).toBe("pending");
  });
  it.each(["EWOULDBLOCK", "EAGAIN", "slot"])("maps finalizer %s contention to HTTP 503 without retrying", async (code) => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    const failure = code === "slot" ? new Error("Isolated finalizer is busy") : new Error("root pin failed", { cause: Object.assign(new Error("native lock busy"), { code }) });
    const finalize = jest.spyOn(SsdCrossFsFinalizer.prototype, "finalize").mockRejectedValue(failure);
    await expect(service.completeUpload(7, session.uploadId)).rejects.toMatchObject({ status: 503 });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("uploading");
  });
  it("maps recovery lock contention to HTTP 503 while preserving an ambiguous commit error", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    reserved = true;
    store.lookup = jest.fn(async () => ({ operation: { cleanupState: "pending" }, file: null }));
    const recover = jest.spyOn(SsdFinalizationRecovery.prototype, "recover").mockRejectedValue(Object.assign(new Error("native lock busy"), { code: "EWOULDBLOCK" }));
    await expect(service.completeUpload(7, session.uploadId)).rejects.toMatchObject({ status: 503 });
    const ambiguity = new Error("Commit response lost; outcome unknown");
    recover.mockRejectedValue(ambiguity);
    await expect(service.completeUpload(7, session.uploadId)).rejects.toBe(ambiguity);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(session.status).toBe("pending");
  });
  it("cancels and removes only content-verified manifest chunks, preserving unknown artifacts", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    const unknown = path.join(session.tempPath, "unknown.bin"); fs.writeFileSync(unknown, "retain");
    await service.abortUpload(7, session.uploadId);
    expect(session.status).toBe("aborted");
    expect(fs.existsSync(path.join(session.tempPath, "0"))).toBe(false);
    expect(fs.readFileSync(unknown, "utf8")).toBe("retain");
    expect(sessions).toHaveLength(1);
    expect(chunks).toHaveLength(0);
  });
  it("expiry cancellation preserves a changed recorded chunk rather than guessing ownership", async () => {
    const session = await service.createUploadSession(7, "file.txt", bytes.length, bytes.length, undefined, expectedSha256);
    await service.uploadChunk(7, session.uploadId, 0, bytes);
    fs.writeFileSync(path.join(session.tempPath, "0"), "wrong");
    session.expiresAt = new Date(0);
    await service.cleanupExpiredSessions();
    expect(session.status).toBe("aborted");
    expect(fs.readFileSync(path.join(session.tempPath, "0"), "utf8")).toBe("wrong");
    expect(chunks).toHaveLength(1);
  });
  it("startup recovery is explicit and makes one bounded pass without retries", async () => {
    await service.onModuleInit();
    expect(db.query).not.toHaveBeenCalled();
    service = new SsdUploadsService(db, storage, configuration({ UPLOAD_SSD_RECOVERY_MODE: "once" }) as any, store);
    reserved = true;
    const recover = jest.spyOn(service as any, "recovery").mockRejectedValue(new Error("unknown artifact"));
    await service.onModuleInit(); await service.onModuleInit();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 128"));
  });
});
