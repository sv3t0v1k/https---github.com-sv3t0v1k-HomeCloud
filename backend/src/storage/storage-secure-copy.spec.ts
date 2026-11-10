import { ConfigService } from "@nestjs/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StorageService } from "./storage.service";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("StorageService secure descriptor-based copy", () => {
  let root: string;
  let source: string;
  let destination: string;
  let storage: StorageService;

  const content = Buffer.alloc(512 * 1024 + 17, 0x5a);

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hc-secure-copy-")),
    );
    source = path.join(root, "source.bin");
    destination = path.join(root, "destination.bin");
    fs.writeFileSync(source, content);

    storage = new StorageService(
      new ConfigService({
        STORAGE_PATH: root,
        NODE_ENV: "test",
      }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    storage.onModuleDestroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a pre-cancelled copy without creating a destination", async () => {
    const controller = new AbortController();
    controller.abort();

    const fd = storage.openReadOnlyFileSecure(source);
    try {
      await expect(
        storage.copyOpenedFileSecure(
          fd,
          content.length,
          destination,
          controller.signal,
        ),
      ).rejects.toThrow("Secure copy cancelled");

      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("cancels an active copy after its outstanding I/O settles", async () => {
    const controller = new AbortController();
    const fd = storage.openReadOnlyFileSecure(source);

    try {
      const operation = storage.copyOpenedFileSecure(
        fd,
        content.length,
        destination,
        controller.signal,
      );

      // The destination is opened synchronously before the first read.
      expect(fs.existsSync(destination)).toBe(true);
      controller.abort();

      await expect(operation).rejects.toThrow("Secure copy cancelled");

      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readFileSync(source)).toEqual(content);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("limits physical copies to four and restores capacity after cancellation", async () => {
    const fd = storage.openReadOnlyFileSecure(source);
    const controllers = Array.from({ length: 4 }, () => new AbortController());

    const destinations = controllers.map((_, index) =>
      path.join(root, `parallel-${index}.bin`),
    );

    try {
      const pending = controllers.map((controller, index) =>
        storage.copyOpenedFileSecure(
          fd,
          content.length,
          destinations[index],
          controller.signal,
        ),
      );

      // A fifth physical copy must not open a new destination.
      const overflow = path.join(root, "overflow.bin");
      await expect(
        storage.copyOpenedFileSecure(fd, content.length, overflow),
      ).rejects.toThrow("Secure copy concurrency limit exceeded");

      expect(fs.existsSync(overflow)).toBe(false);

      controllers.forEach((controller) => controller.abort());

      const results = await Promise.allSettled(pending);
      expect(results.every((result) => result.status === "rejected")).toBe(
        true,
      );

      for (const target of destinations) {
        expect(fs.existsSync(target)).toBe(false);
      }

      // Capacity is reusable, with no leaked descriptors or slots.
      const lease = await storage.copyOpenedFileSecure(
        fd,
        content.length,
        destination,
      );

      try {
        expect(fs.readFileSync(destination)).toEqual(content);
      } finally {
        lease.release();
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  it("copies every byte through secured descriptors", async () => {
    const fd = storage.openReadOnlyFileSecure(source);

    try {
      const lease = await storage.copyOpenedFileSecure(
        fd,
        content.length,
        destination,
      );

      try {
        expect(fs.readFileSync(destination)).toEqual(content);
      } finally {
        lease.release();
      }

      expect(fs.existsSync(destination)).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("removes only its own destination on metadata rollback", async () => {
    const fd = storage.openReadOnlyFileSecure(source);

    try {
      const lease = await storage.copyOpenedFileSecure(
        fd,
        content.length,
        destination,
      );

      try {
        lease.cleanup();
        lease.cleanup();
        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readFileSync(source)).toEqual(content);
      } finally {
        lease.release();
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  it("refuses existing destinations and never overwrites them", async () => {
    fs.writeFileSync(destination, "original destination");
    const fd = storage.openReadOnlyFileSecure(source);

    try {
      await expect(
        storage.copyOpenedFileSecure(fd, content.length, destination),
      ).rejects.toThrow();

      expect(fs.readFileSync(destination, "utf8")).toBe("original destination");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("rejects symlink destinations and hardlinked sources", async () => {
    const external = path.join(root, "external.bin");
    fs.writeFileSync(external, "protected");
    fs.symlinkSync(external, destination);

    const fd = storage.openReadOnlyFileSecure(source);
    try {
      await expect(
        storage.copyOpenedFileSecure(fd, content.length, destination),
      ).rejects.toThrow();
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(external, "utf8")).toBe("protected");

    const hardlink = path.join(root, "hardlink.bin");
    fs.linkSync(source, hardlink);
    expect(() => storage.openReadOnlyFileSecure(source)).toThrow();
  });

  it("rejects changed source size before creating a destination", async () => {
    const fd = storage.openReadOnlyFileSecure(source);
    try {
      await expect(
        storage.copyOpenedFileSecure(fd, content.length - 1, destination),
      ).rejects.toThrow("Unsafe or changed copy source");
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });
});
