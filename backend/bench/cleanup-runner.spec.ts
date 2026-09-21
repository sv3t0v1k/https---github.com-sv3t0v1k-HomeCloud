import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "../src/storage/storage.service";
import {
  benchStoragePath,
  verifyBenchStorageIsolation,
} from "./cleanup-runner";

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
});