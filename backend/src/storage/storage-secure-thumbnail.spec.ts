import { ConfigService } from "@nestjs/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SecureFilesystem } from "../uploads/secure-filesystem";
import { StorageService } from "./storage.service";

const describeLinux = process.platform === "linux"
  ? describe
  : describe.skip;

describeLinux("Secure thumbnail storage FD", () => {
  let root: string;
  let outside: string;
  let service: StorageService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-thumb-fd-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "hc-thumb-out-"));

    service = new StorageService(
      new ConfigService({ STORAGE_PATH: root }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    service?.onModuleDestroy();

    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  });

  it("opens a regular file through the secure root descriptor", () => {
    const directory = path.join(root, "user");
    fs.mkdirSync(directory);

    const filePath = path.join(directory, "picture.png");
    fs.writeFileSync(filePath, Buffer.from("trusted image"));

    const placement = service.placementForPath(filePath);
    expect(service.resolveFilePath(placement)).toBe(filePath);

    const fd = service.openReadOnlyFileSecure(filePath);
    try {
      expect(fs.readFileSync(fd).toString()).toBe("trusted image");
      expect(fs.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("blocks ancestor substitution between validation and native open", () => {
    const directory = path.join(root, "user");
    const displaced = path.join(root, "user-displaced");
    const filePath = path.join(directory, "picture.png");

    fs.mkdirSync(directory);
    fs.writeFileSync(filePath, "inside");
    fs.writeFileSync(path.join(outside, "picture.png"), "outside");

    const placement = service.placementForPath(filePath);
    expect(service.resolveFilePath(placement)).toBe(filePath);

    const realOpen = SecureFilesystem.prototype.open;
    let substituted = false;

    jest.spyOn(SecureFilesystem.prototype, "open")
      .mockImplementation(function (
        this: SecureFilesystem,
        absolute: string,
        mode: "r" | "rw" | "wx" = "r",
      ) {
        if (!substituted) {
          fs.renameSync(directory, displaced);
          fs.symlinkSync(outside, directory);
          substituted = true;
        }
        return realOpen.call(this, absolute, mode);
      });

    try {
      expect(() =>
        service.openReadOnlyFileSecure(filePath),
      ).toThrow();

      expect(substituted).toBe(true);
      expect(fs.readFileSync(
        path.join(outside, "picture.png"),
        "utf8",
      )).toBe("outside");
    } finally {
      jest.restoreAllMocks();

      if (
        fs.existsSync(directory) &&
        fs.lstatSync(directory).isSymbolicLink()
      ) {
        fs.unlinkSync(directory);
      }
      if (fs.existsSync(displaced)) {
        fs.renameSync(displaced, directory);
      }
    }
  });

  it("fails closed if the secure native open is unavailable", () => {
    const filePath = path.join(root, "image.png");
    fs.writeFileSync(filePath, "image");

    jest.spyOn(SecureFilesystem.prototype, "open")
      .mockImplementationOnce(() => {
        throw new Error("secure open unavailable");
      });

    expect(() =>
      service.openReadOnlyFileSecure(filePath),
    ).toThrow("secure open unavailable");
  });

  it("rejects hardlinks and symlink leaves", () => {
    const filePath = path.join(root, "image.png");
    fs.writeFileSync(filePath, "image");

    fs.linkSync(filePath, path.join(outside, "alias"));
    expect(() =>
      service.openReadOnlyFileSecure(filePath),
    ).toThrow();

    fs.unlinkSync(path.join(outside, "alias"));
    fs.unlinkSync(filePath);
    fs.symlinkSync(path.join(outside, "alias"), filePath);

    expect(() =>
      service.openReadOnlyFileSecure(filePath),
    ).toThrow();
  });
});
