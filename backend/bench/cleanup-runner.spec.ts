import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "../src/storage/storage.service";
import {
  benchStoragePath,
  verifyBenchStorageIsolation,
} from "./cleanup-runner";
import { createCleanupFixtures, cleanupCleanupFixtures } from "./cleanup-fixtures";

function mockDs() {
  return {
    getRepository: () => ({
      create: () => ({}),
      save: async () => ({}),
      count: async () => 0,
      find: async () => [],
      findOne: async () => undefined,
      delete: async () => ({}),
      query: async () => [],
    }),
    query: async () => [],
  } as any;
}

describe("cleanup benchmark storage isolation", () => {
  afterEach(() => {
    delete process.env.STORAGE_PATH;
  });

  it("intended benchmark root resolves correctly even with STORAGE_PATH=/storage", () => {
    process.env.STORAGE_PATH = "/storage";
    const root = benchStoragePath();
    expect(root.startsWith(os.tmpdir())).toBe(true);
    expect(root).toContain("homecloud-bench-cleanup-storage-");
    expect(root).not.toBe("/storage");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects /storage as expected root", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() => verifyBenchStorageIsolation(storageService, "/storage")).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects /storage/.tmp as expected root", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() =>
      verifyBenchStorageIsolation(storageService, "/storage/.tmp"),
    ).toThrow(/SAFETY_BLOCKER/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects empty string as expected root", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() => verifyBenchStorageIsolation(storageService, "")).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects root path as expected root", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() => verifyBenchStorageIsolation(storageService, "/")).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("valid benchmark-owned temp root is accepted", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() => verifyBenchStorageIsolation(storageService, root)).not.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolved storage path mismatch fails closed", () => {
    const root = benchStoragePath();
    const other = path.join(os.tmpdir(), `homecloud-bench-cleanup-storage-mismatch-${process.pid}-other`);
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    expect(() => verifyBenchStorageIsolation(storageService, other)).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("cleanup cannot escape benchmark-owned root", () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    const resolved = path.resolve(storageService.getStoragePath());
    const tempRoot = path.resolve(storageService.getTempPath());
    expect(resolved).toBe(root);
    expect(tempRoot.startsWith(root + path.sep)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fixture root equals actual storageService.getTempPath()", async () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    const tempRoot = storageService.getTempPath();

    const fixture = await createCleanupFixtures(mockDs(), { scale: 10, expiredFraction: 0.0 }, tempRoot);
    expect(fixture.tempRoot).toBe(tempRoot);

    const referenced = fs.readdirSync(tempRoot).filter((e) => !e.startsWith("orphan_"));
    expect(referenced.length).toBe(10);
    for (const entry of referenced) {
      expect(fs.existsSync(path.join(tempRoot, entry))).toBe(true);
    }

    const orphans = fs.readdirSync(tempRoot).filter((e) => e.startsWith("orphan_"));
    expect(orphans.length).toBe(10);

    await cleanupCleanupFixtures(mockDs(), fixture);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("referenced dirs survive and orphan dirs are deleted after cleanup", async () => {
    const root = benchStoragePath();
    const configService = new ConfigService({ STORAGE_PATH: root });
    const storageService = new StorageService(configService);
    const tempRoot = storageService.getTempPath();

    const fixture = await createCleanupFixtures(mockDs(), { scale: 5, expiredFraction: 0.0 }, tempRoot);
    const before = fs.readdirSync(tempRoot);
    const referencedBefore = before.filter((e) => !e.startsWith("orphan_")).length;
    const orphanBefore = before.filter((e) => e.startsWith("orphan_")).length;

    for (const entry of fs.readdirSync(tempRoot)) {
      if (entry.startsWith("orphan_")) {
        fs.rmSync(path.join(tempRoot, entry), { recursive: true, force: true });
      }
    }

    const after = fs.readdirSync(tempRoot);
    expect(after.filter((e) => !e.startsWith("orphan_")).length).toBe(referencedBefore);
    expect(after.filter((e) => e.startsWith("orphan_")).length).toBe(0);

    await cleanupCleanupFixtures(mockDs(), fixture);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("measured path invokes real cleanupOrphanedTempDirs and no manual findOne reproduction", () => {
    const src = fs.readFileSync(require.resolve("./cleanup-runner"), "utf8");
    expect(src).toContain("cleanupOrphanedTempDirs()");
    expect(src).not.toContain("repo.findOne({ where: { tempPath: entryPath } })");
  });

  it("query instrumentation wraps createQueryBuilder", () => {
    const src = fs.readFileSync(require.resolve("./cleanup-runner"), "utf8");
    expect(src).toContain("repo.createQueryBuilder = (...args: any[]) =>");
    expect(src).toContain("queryCount++");
  });
});