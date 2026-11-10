import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { FileEntity } from "../src/entities/file.entity";
import { StorageService } from "../src/storage/storage.service";
import { FilesService } from "../src/files/files.service";
import { createCopyFileInstrument } from "./copy-file-instrument";
import {
  COPY_FILE_SCALES,
  verifyCopyIsolation,
  writeDeterministicFixture,
} from "./copy-file-runner";

describe("copy-file benchmark harness", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-copy-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the required practical scales", () => {
    expect(Array.from(COPY_FILE_SCALES)).toEqual([
      1 * 1024 * 1024,
      10 * 1024 * 1024,
      50 * 1024 * 1024,
      100 * 1024 * 1024,
    ]);
  });

  it("creates deterministic exact-size fixtures outside measurement", () => {
    const first = path.join(tmp, "first.bin");
    const second = path.join(tmp, "second.bin");
    const hash1 = writeDeterministicFixture(first, 1024 * 1024 + 17);
    const hash2 = writeDeterministicFixture(second, 1024 * 1024 + 17);
    expect(fs.statSync(first).size).toBe(1024 * 1024 + 17);
    expect(hash1).toBe(hash2);
  });

  it("instruments the real asynchronous filesystem operation", async () => {
    const source = path.join(tmp, "source.bin");
    const destination = path.join(tmp, "destination.bin");
    fs.writeFileSync(source, "correctness-marker");
    const instrument = createCopyFileInstrument();
    instrument.start();
    await fs.promises.copyFile(source, destination);
    instrument.restore();
    const sample = await instrument.settled();
    expect(instrument.calls()).toBe(0);
    expect(instrument.asyncAttempts()).toBe(1);
    expect(typeof sample.immediateRanBeforeReturn).toBe("boolean");
    expect(sample.immediateDelayMs).toBeGreaterThanOrEqual(0);
    expect(sample.operationMs).toBeGreaterThanOrEqual(0);
    expect(fs.readFileSync(destination, "utf8")).toBe("correctness-marker");
  });

  (process.platform === "linux" ? it : it.skip)(
    "invokes production FilesService with secure Linux storage",
    async () => {
      const source = path.join(tmp, "source.bin");
      fs.writeFileSync(source, "real-production-path");

      const storage = new StorageService(
        new ConfigService({
          STORAGE_PATH: tmp,
          NODE_ENV: "test",
        }),
      );

      try {
        const file = {
          id: 7,
          userId: 1,
          name: "source.bin",
          ...storage.placementForPath(source),
          size: 20,
          mimeType: "text/plain",
          isFolder: false,
          isDeleted: false,
          parentId: null,
        };

        const query = jest.fn(async (sql: string) => {
          if (sql.includes("SELECT id FROM users")) {
            return [{ id: 1 }];
          }
          return [];
        });

        const findOne = jest.fn(async (entity: unknown) => {
          return entity === FileEntity ? file : null;
        });

        const transactionManager = {
          query,
          findOne,
        };

        const runner = {
          isTransactionActive: false,
          connect: jest.fn(),
          startTransaction: jest.fn(),
          commitTransaction: jest.fn(),
          rollbackTransaction: jest.fn(),
          release: jest.fn(),
          manager: {
            query,
            findOne,
            create: jest.fn((_entity: unknown, value: any) => value),
            save: jest.fn(async (value: any) => {
              value.id = 8;
              return value;
            }),
          },
        };

        const repository = {
          findOne: jest.fn().mockResolvedValue(file),
          manager: {
            transaction: jest.fn(
              async (
                callback: (
                  manager: typeof transactionManager,
                ) => Promise<unknown>,
              ) => callback(transactionManager),
            ),
            connection: {
              createQueryRunner: jest.fn(() => runner),
            },
          },
        };

        const users = {
          findById: jest.fn().mockResolvedValue({
            id: 1,
            isActive: true,
          }),
          updateStorageUsed: jest.fn(),
        };

        const service = new FilesService(
          repository as never,
          {} as never,
          storage,
          users as never,
        );

        const result = await service.copyFile(1, 7);

        expect(result.storagePath).not.toBe(source);
        expect(result.storagePath.startsWith(tmp + path.sep)).toBe(true);
        expect(fs.readFileSync(result.storagePath, "utf8")).toBe(
          "real-production-path",
        );

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(runner.manager.save).toHaveBeenCalledTimes(1);
        expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
        expect(runner.rollbackTransaction).not.toHaveBeenCalled();

        expect(users.updateStorageUsed).toHaveBeenCalledWith(
          1,
          20,
          runner.manager,
        );

        expect(fs.readFileSync(source, "utf8")).toBe("real-production-path");
      } finally {
        storage.onModuleDestroy();
      }
    },
  );

  it("fails closed for normal or mismatched storage roots", () => {
    const service = { getStoragePath: () => tmp };
    expect(() => verifyCopyIsolation(service as never, tmp)).not.toThrow();
    expect(() => verifyCopyIsolation(service as never, "/storage")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() =>
      verifyCopyIsolation(
        { getStoragePath: () => "/storage" } as never,
        "/storage",
      ),
    ).toThrow(/SAFETY_BLOCKER/);
  });

  it("failure-path cleanup primitive removes the isolated tree", () => {
    const nested = path.join(tmp, "user", "copy.bin");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "x");
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(fs.existsSync(tmp)).toBe(false);
  });
});
