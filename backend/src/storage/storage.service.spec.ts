import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "./storage.service";

describe("StorageService.deleteFile", () => {
  let storagePath: string;
  let service: StorageService;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-storage-"));
    service = new StorageService({
      get: jest.fn((key: string) =>
        key === "STORAGE_PATH" ? storagePath : undefined,
      ),
    } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  it("awaits async unlink and removes an existing file", async () => {
    const filePath = path.join(storagePath, "existing.txt");
    fs.writeFileSync(filePath, "data");
    const actualUnlink = fs.promises.unlink.bind(fs.promises);
    let unlinkStarted!: () => void;
    let allowUnlink!: () => void;
    const started = new Promise<void>((resolve) => {
      unlinkStarted = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      allowUnlink = resolve;
    });
    const unlinkSpy = jest
      .spyOn(fs.promises, "unlink")
      .mockImplementationOnce(async (target) => {
        unlinkStarted();
        await allowed;
        await actualUnlink(target);
      });
    let settled = false;
    const deletion = service.deleteFile(filePath).then(() => {
      settled = true;
    });
    await started;

    expect(unlinkSpy).toHaveBeenCalledWith(path.resolve(filePath));
    expect(settled).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    allowUnlink();
    await deletion;

    expect(settled).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("treats a missing file as an idempotent success", async () => {
    await expect(
      service.deleteFile(path.join(storagePath, "missing.txt")),
    ).resolves.toBeUndefined();
  });

  it("rejects non-ENOENT unlink errors", async () => {
    const error = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    jest.spyOn(fs.promises, "unlink").mockRejectedValueOnce(error);

    await expect(
      service.deleteFile(path.join(storagePath, "blocked.txt")),
    ).rejects.toBe(error);
  });
});

describe("StorageService.copyFile", () => {
  let storagePath: string;
  let service: StorageService;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-storage-"));
    service = new StorageService({
      get: jest.fn((key: string) =>
        key === "STORAGE_PATH" ? storagePath : undefined,
      ),
    } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  it("awaits async exclusive copy and preserves exact bytes", async () => {
    const source = path.join(storagePath, "source.bin");
    const destination = path.join(storagePath, "destination.bin");
    const contents = Buffer.from([0, 1, 2, 3, 255]);
    fs.writeFileSync(source, contents);
    const actualCopy = fs.promises.copyFile.bind(fs.promises);
    let allowCopy!: () => void;
    const allowed = new Promise<void>((resolve) => {
      allowCopy = resolve;
    });
    const copySpy = jest
      .spyOn(fs.promises, "copyFile")
      .mockImplementationOnce(async (from, to, mode) => {
        await allowed;
        await actualCopy(from, to, mode);
      });
    let settled = false;
    const operation = service.copyFile(source, destination).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(copySpy).toHaveBeenCalledWith(
      path.resolve(source),
      path.resolve(destination),
      fs.constants.COPYFILE_EXCL,
    );
    allowCopy();
    await operation;

    expect(fs.readFileSync(destination)).toEqual(contents);
    expect(fs.readFileSync(source)).toEqual(contents);
  });

  it("does not overwrite an existing destination", async () => {
    const source = path.join(storagePath, "source.txt");
    const destination = path.join(storagePath, "destination.txt");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(destination, "existing");

    await expect(service.copyFile(source, destination)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(fs.readFileSync(destination, "utf8")).toBe("existing");
    expect(fs.readFileSync(source, "utf8")).toBe("source");
  });

  it("rejects missing source and paths outside storage root", async () => {
    await expect(
      service.copyFile(
        path.join(storagePath, "missing.txt"),
        path.join(storagePath, "copy.txt"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      service.copyFile("/outside/source.txt", path.join(storagePath, "copy.txt")),
    ).rejects.toThrow("Path traversal detected");
    await expect(
      service.copyFile(path.join(storagePath, "source.txt"), "/outside/copy.txt"),
    ).rejects.toThrow("Path traversal detected");
  });
});

describe("StorageService.generateFinalPath filename boundaries", () => {
  let storagePath: string;
  let service: StorageService;
  const uploadId = "9cafc2b1-6af4-4b82-8fbf-392962743285";
  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-filename-"));
    service = new StorageService({
      get: (key: string) => (key === "STORAGE_PATH" ? storagePath : undefined),
    } as ConfigService);
  });
  afterEach(() => fs.rmSync(storagePath, { recursive: true, force: true }));

  it.each(["a".repeat(251) + ".BIN", "report." + "Я".repeat(180)])(
    "stores exact bytes at a deterministic bounded path for long logical filename %s",
    async (filename) => {
      const target = service.generateFinalPath(7, uploadId, filename);
      expect(path.basename(target)).toBe(`${uploadId}.upload`);
      expect(
        Buffer.byteLength(path.basename(target), "utf8"),
      ).toBeLessThanOrEqual(255);
      expect(path.dirname(target)).toBe(path.join(storagePath, "7"));
      const bytes = Buffer.from([0, 1, 2, 255, 128]);
      await service.writeFile(target, bytes);
      expect(fs.readFileSync(target)).toEqual(bytes);
      expect(service.generateFinalPath(7, uploadId, filename)).toBe(target);
    },
  );

  it("retains the existing ordinary path algorithm", () => {
    expect(service.generateFinalPath(7, uploadId, "My report.BIN")).toBe(
      path.join(storagePath, "7", `My_report_${uploadId}.bin`),
    );
  });

  it("retains an exactly 255-byte generated disk component", async () => {
    const filename = "a".repeat(214) + ".BIN";
    const target = service.generateFinalPath(7, uploadId, filename);
    expect(Buffer.byteLength(path.basename(target), "utf8")).toBe(255);
    expect(path.basename(target)).toBe(`${"a".repeat(214)}_${uploadId}.bin`);
    await service.writeFile(target, Buffer.from([0, 255]));
    expect(fs.readFileSync(target)).toEqual(Buffer.from([0, 255]));
  });
});
