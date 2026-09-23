import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
    expect(sample.immediateRanBeforeReturn).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe("correctness-marker");
  });

  it("invokes the real production copyFile method", async () => {
    const source = path.join(tmp, "source.bin");
    const destination = path.join(tmp, "destination.bin");
    fs.writeFileSync(source, "real-production-path");
    const file = {
      id: 7,
      name: "source.bin",
      storagePath: source,
      size: 20,
      mimeType: "text/plain",
    };
    const fileRepository = {
      findOne: jest.fn().mockResolvedValue(file),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: 8 })),
    };
    const folderRepository = { findOne: jest.fn() };
    const storageService = {
      generateSafeFilename: jest.fn(() => "copy.bin"),
      generatePath: jest.fn(() => destination),
      copyFile: jest.fn((from, to) =>
        fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL),
      ),
      deleteFile: jest.fn((target) => fs.promises.unlink(target)),
    };
    const usersService = {
      findById: jest.fn().mockResolvedValue({ id: 1 }),
      updateStorageUsed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new FilesService(
      fileRepository as never,
      folderRepository as never,
      storageService as never,
      usersService as never,
    );
    const result = await service.copyFile(1, 7);
    expect(result.storagePath).toBe(destination);
    expect(fs.readFileSync(destination, "utf8")).toBe("real-production-path");
    expect(fileRepository.save).toHaveBeenCalledTimes(1);
    expect(usersService.updateStorageUsed).toHaveBeenCalledWith(1, 20);
  });

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
