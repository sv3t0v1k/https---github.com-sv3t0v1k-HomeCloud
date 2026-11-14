import { ConfigService } from "@nestjs/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StorageService } from "./storage.service";

const describeLinux = process.platform === "linux"
  ? describe
  : describe.skip;

describeLinux("StorageService immutable secure-read root", () => {
  let root: string;
  let oldRoot: string;
  let file: string;
  let service: StorageService | undefined;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "hc-read-root-"),
    ));
    oldRoot = root + ".old";
    file = path.join(root, "secret.bin");

    fs.writeFileSync(file, "trusted-secret");

    service = new StorageService(
      new ConfigService({
        STORAGE_PATH: root,
        NODE_ENV: "test",
      }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    service?.onModuleDestroy();

    for (const directory of [root, oldRoot]) {
      if (fs.existsSync(directory)) {
        fs.rmSync(directory, {
          recursive: true,
          force: true,
        });
      }
    }

    service = undefined;
  });

  it("opens an approved file through the pinned native root", () => {
    const fd = service!.openReadOnlyFileSecure(file);

    try {
      expect(fs.readFileSync(fd, "utf8"))
        .toBe("trusted-secret");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("rejects a root swap after authorization but before opening", () => {
    // Precisely reproduce the old TOCTOU:
    // keyFromAbsolute passes, assertAccess passes,
    // then the approved root pathname is replaced.
    const registry = (
      service as unknown as {
        registry: {
          mounts: {
            assertAccess: (
              id: string,
              write?: boolean,
            ) => unknown;
          };
        };
      }
    ).registry;

    const mounts = registry.mounts;
    const original = mounts.assertAccess.bind(mounts);

    let checks = 0;
    let swapped = false;

    jest.spyOn(mounts, "assertAccess")
      .mockImplementation((id, write = false) => {
        const approved = original(id, write);
        checks++;

        if (checks === 2) {
          fs.renameSync(root, oldRoot);
          fs.mkdirSync(root, { mode: 0o700 });
          fs.writeFileSync(file, "attacker-secret");
          swapped = true;
        }

        return approved;
      });

    expect(() =>
      service!.openReadOnlyFileSecure(file),
    ).toThrow();

    expect(swapped).toBe(true);
    expect(fs.readFileSync(file, "utf8"))
      .toBe("attacker-secret");
    expect(fs.readFileSync(
      path.join(oldRoot, "secret.bin"),
      "utf8",
    )).toBe("trusted-secret");
  });

  it("cannot reuse the native root after shutdown", () => {
    service!.onModuleDestroy();

    expect(() =>
      service!.openReadOnlyFileSecure(file),
    ).toThrow();
  });
});
