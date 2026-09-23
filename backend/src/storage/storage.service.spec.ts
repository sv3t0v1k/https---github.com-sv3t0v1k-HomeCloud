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
