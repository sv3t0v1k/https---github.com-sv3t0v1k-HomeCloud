import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Request, Response } from "express";

import { FileEntity } from "../entities/file.entity";
import { StorageService } from "../storage/storage.service";
import { FilesService } from "./files.service";
import { streamOriginalDownload } from "./files.controller";

describe("Download descriptor lifecycle", () => {
  let root: string;
  let filePath: string;
  let openedFd: number | undefined;
  let file: FileEntity;

  beforeEach(() => {
    openedFd = undefined;
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hc-download-lifecycle-"),
    );
    filePath = path.join(root, "proof.bin");
    fs.writeFileSync(filePath, "trusted-content");

    file = {
      id: 7,
      userId: 42,
      name: "proof.bin",
      storagePath: filePath,
      mimeType: "application/octet-stream",
      isFolder: false,
      isDeleted: false,
    } as FileEntity;
  });

  afterEach(() => {
    if (openedFd !== undefined) {
      try {
        fs.closeSync(openedFd);
      } catch (error) {
        if ((error as { code?: string }).code !== "EBADF") {
          throw error;
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function response() {
    return Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    }) as unknown as Response;
  }

  function request() {
    return {
      user: { userId: 42 },
      method: "GET",
      headers: {},
    } as unknown as Request & { user: { userId: number } };
  }

  function storageService() {
    return {
      resolveFilePath: jest.fn(() => filePath),
      openReadOnlyFileSecure: jest.fn(() => {
        openedFd = fs.openSync(filePath, "r");
        return openedFd;
      }),
    };
  }

  function assertClosed() {
    expect(openedFd).toBeDefined();
    try {
      fs.fstatSync(openedFd!);
      throw new Error("File descriptor is still open");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("EBADF");
    }
  }

  it("closes an opened FD when COMMIT fails after callback", async () => {
    const storage = storageService();
    const files = {
      withVisibleContentFile: async (
        _userId: number,
        _fileId: number,
        access: (value: FileEntity) => unknown,
      ) => {
        const result = access(file);
        expect(result).toMatchObject({
          fd: expect.any(Number),
        });
        throw new Error("Simulated PostgreSQL COMMIT failure");
      },
    };

    const res = response();

    await expect(streamOriginalDownload(
      files as unknown as FilesService,
      storage as unknown as StorageService,
      request(),
      "7",
      res,
    )).rejects.toThrow("Simulated PostgreSQL COMMIT failure");

    assertClosed();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("does not open storage when HTTP closes during authorization", async () => {
    let enter!: () => void;
    let release!: () => void;

    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pendingAuthorization = new Promise<void>((resolve) => {
      release = resolve;
    });

    const storage = storageService();
    const files = {
      withVisibleContentFile: async (
        _userId: number,
        _fileId: number,
        access: (value: FileEntity) => unknown,
      ) => {
        enter();
        await pendingAuthorization;
        return access(file);
      },
    };

    const res = response();

    const operation = streamOriginalDownload(
      files as unknown as FilesService,
      storage as unknown as StorageService,
      request(),
      "7",
      res,
    );

    await entered;
    res.destroyed = true;
    res.emit("close");
    release();

    await expect(operation).resolves.toBeUndefined();
    expect(storage.openReadOnlyFileSecure).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("closes an FD if HTTP disconnects before COMMIT completes", async () => {
    const storage = storageService();
    const res = response();

    const files = {
      withVisibleContentFile: async (
        _userId: number,
        _fileId: number,
        access: (value: FileEntity) => unknown,
      ) => {
        const result = access(file);
        res.destroyed = true;
        res.emit("close");
        return result;
      },
    };

    await expect(streamOriginalDownload(
      files as unknown as FilesService,
      storage as unknown as StorageService,
      request(),
      "7",
      res,
    )).resolves.toBeUndefined();

    assertClosed();
    expect(res.listenerCount("close")).toBe(0);
  });
});
