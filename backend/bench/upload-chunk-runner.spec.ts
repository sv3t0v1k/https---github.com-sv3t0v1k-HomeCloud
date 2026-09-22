import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { UploadsService } from "../src/uploads/uploads.service";
import {
  measureUploadChunkScale,
  buildUploadChunkServices,
  UPLOAD_CHUNK_SCALES,
  verifyIsolation,
  UploadChunkMeasurement,
  UploadChunkServices,
} from "./upload-chunk-runner";
import { createFsInstrument } from "./fs-instrument";
import { StorageService } from "../src/storage/storage.service";

function mockDataSource(): DataSource {
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
  } as unknown as DataSource;
}

function mockServices(
  overrides: Partial<UploadsService> = {},
): UploadChunkServices & { uploadsService: UploadsService } {
  const calls: string[] = [];
  const uploadsService = {
    createUploadSession: async () => ({ uploadId: "sess-1", status: "pending" }),
    uploadChunk: async () => ({ status: "uploading", uploadedChunks: [0] }),
    abortUpload: async () => {},
    ...overrides,
  } as unknown as UploadsService;
  return {
    uploadsService,
    storageService: {
      getTempPath: () => "/tmp/homecloud-bench-uploadchunk-pid",
    } as unknown as StorageService,
    benchRoot: "/tmp/homecloud-bench-uploadchunk-pid",
  };
}

describe("uploadChunk measurement runner", () => {
  it("scales are exactly 100/1000/5000", () => {
    expect(Array.from(UPLOAD_CHUNK_SCALES)).toEqual([100, 1000, 5000]);
  });

  it("production uploadChunk is invoked (real method reference, no simulation)", () => {
    const src = fs.readFileSync(
      require.resolve("./upload-chunk-runner"),
      "utf8",
    );
    expect(src).toContain("uploadsService.uploadChunk(");
    expect(src).not.toContain("// simulate");
    expect(src).not.toContain("Math.random");
  });

  it("instrumentation surrounds only the measured invocation", () => {
    const src = fs.readFileSync(
      require.resolve("./upload-chunk-runner"),
      "utf8",
    );
    expect(src).toContain("instrument.start()");
    expect(src).toContain("instrument.restore()");
    expect(src).toContain("instrument.snapshot()");
    const startIdx = src.indexOf("instrument.start()");
    const restoreIdx = src.indexOf("instrument.restore()");
    const callIdx = src.indexOf("uploadsService.uploadChunk(");
    expect(startIdx).toBeLessThan(callIdx);
    expect(callIdx).toBeLessThan(restoreIdx);
  });

  it("measurement result shape is correct", async () => {
    const services = mockServices();
    const result = await measureUploadChunkScale(
      mockDataSource(),
      100,
      services,
    );
    const m: UploadChunkMeasurement = result.measurement;
    expect(m.scale).toBe(100);
    expect(m.totalChunks).toBe(100);
    expect(typeof m.latencyMs).toBe("number");
    expect(m.latencyMs).toBeGreaterThanOrEqual(0);
    expect(m.counters).toHaveProperty("existsSync");
    expect(m.counters).toHaveProperty("statSync");
    expect(m.sessionStatus).toBe("uploading");
    expect(m.uploadedChunks).toBe(1);
    expect(result.residualRows.sessions).toBe(0);
    expect(result.residualFs).toBe(0);
  });

  it("cleanup executes on failure path", async () => {
    const aborted: string[] = [];
    const services = mockServices({
      createUploadSession: async () => {
        throw new Error("forced setup failure");
      },
      abortUpload: async (_userId: number, u: string) => {
        aborted.push(u);
      },
    });
    await expect(
      measureUploadChunkScale(mockDataSource(), 100, services),
    ).rejects.toThrow(/forced setup failure/);
  });

  it("unsafe/mismatched storage root fails closed", () => {
    const benchRoot = "/tmp/homecloud-bench-uploadchunk-failclosed";
    const configService = {
      get: (k: string) =>
        k === "STORAGE_PATH" ? benchRoot : undefined,
    } as unknown as ConfigService;
    const storageService = new StorageService(configService);
    expect(() =>
      verifyIsolation(storageService, "/storage"),
    ).toThrow(/SAFETY_BLOCKER/);
    expect(() =>
      verifyIsolation(storageService, "/storage/.tmp"),
    ).toThrow(/SAFETY_BLOCKER/);
    expect(() => verifyIsolation(storageService, "")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() => verifyIsolation(storageService, "/")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() => verifyIsolation(storageService, ".")).toThrow(
      /SAFETY_BLOCKER/,
    );
    const other = path.join(
      os.tmpdir(),
      `homecloud-bench-uploadchunk-mismatch-${process.pid}`,
    );
    expect(() => verifyIsolation(storageService, other)).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(benchRoot, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
});