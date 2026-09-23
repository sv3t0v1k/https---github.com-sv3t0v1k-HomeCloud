import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FilesService } from "../src/files/files.service";
import { createPermanentDeleteInstrument } from "./permanent-delete-instrument";
import {
  PERMANENT_DELETE_BYTES,
  PERMANENT_DELETE_SCALES,
  verifyPermanentDeleteIsolation,
} from "./permanent-delete-runner";

describe("permanent-delete benchmark harness", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-delete-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses exact count scales and fixed small payload", () => {
    expect(Array.from(PERMANENT_DELETE_SCALES)).toEqual([10, 100, 500, 1000]);
    expect(PERMANENT_DELETE_BYTES).toBe(2048);
  });

  it("instruments actual existsSync/unlinkSync and detects their contiguous block", async () => {
    for (let i = 0; i < 3; i++)
      fs.writeFileSync(path.join(root, `${i}.bin`), "x");
    const instrument = createPermanentDeleteInstrument();
    instrument.start();
    for (let i = 0; i < 3; i++) {
      const file = path.join(root, `${i}.bin`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    instrument.markServiceReturned();
    instrument.restore();
    const sample = await instrument.settled();
    expect(sample.existsSync.calls).toBe(3);
    expect(sample.unlinkSync.calls).toBe(3);
    expect(sample.immediateRanBeforeServiceReturn).toBe(false);
  });

  it("invokes real production emptyTrash and its physical deletion loop", async () => {
    const target = path.join(root, "trash.bin");
    fs.writeFileSync(target, "real-path");
    const physical = [{ id: 1, storagePath: target, size: 9 }];
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue(physical),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    };
    const fileRepository = {
      manager: { connection: { createQueryRunner: () => queryRunner } },
    };
    const storageService = {
      deleteFile: jest.fn((file: string) => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }),
    };
    const usersService = { decrementStorageUsed: jest.fn() };
    const service = new FilesService(
      fileRepository as never,
      {} as never,
      storageService as never,
      usersService as never,
    );
    await service.emptyTrash(7);
    expect(storageService.deleteFile).toHaveBeenCalledWith(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(usersService.decrementStorageUsed).toHaveBeenCalledWith(
      7,
      9,
      manager,
    );
  });

  it("does not classify an asynchronous wait as a synchronous region", async () => {
    const target = path.join(root, "one.bin");
    fs.writeFileSync(target, "x");
    const instrument = createPermanentDeleteInstrument();
    instrument.start();
    if (fs.existsSync(target)) fs.unlinkSync(target);
    await new Promise((resolve) => setTimeout(resolve, 25));
    instrument.markServiceReturned();
    instrument.restore();
    const sample = await instrument.settled();
    expect(sample.immediateRanBeforeServiceReturn).toBe(true);
    expect(sample.immediateDelayMs).toBeLessThan(20);
  });

  it("fails closed outside an exact isolated temp root", () => {
    expect(() =>
      verifyPermanentDeleteIsolation(
        { getStoragePath: () => root } as never,
        root,
      ),
    ).not.toThrow();
    expect(() =>
      verifyPermanentDeleteIsolation(
        { getStoragePath: () => "/storage" } as never,
        "/storage",
      ),
    ).toThrow(/SAFETY_BLOCKER/);
  });

  it("cleanup primitive removes fixtures on success or failure", () => {
    const nested = path.join(root, "1", "trash.bin");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "x");
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(root)).toBe(false);
  });
});
