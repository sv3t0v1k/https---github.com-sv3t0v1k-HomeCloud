"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DataSource } = require("typeorm");
const { ConfigService } = require("@nestjs/config");

const {
  FileCopyAdmissionService,
} = require("../dist/files/file-copy-admission.service.js");

const {
  StorageService,
} = require("../dist/storage/storage.service.js");

const park = () =>
  new Promise(() => {
    // Keep the process alive until the parent sends SIGKILL.
    setInterval(() => {}, 1000);
  });

const notify = (phase, operationId) =>
  new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Crash worker requires IPC"));
      return;
    }
    process.send({ phase, operationId }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

async function main() {
  const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
  const schema = process.env.HOMECLOUD_COPY_CRASH_SCHEMA;
  const mode = process.env.HOMECLOUD_COPY_CRASH_MODE;
  const root = process.env.HOMECLOUD_COPY_CRASH_ROOT;
  const storageLocationId =
    process.env.HOMECLOUD_COPY_CRASH_STORAGE_LOCATION_ID;

  if (
    !url ||
    !/^copy_admission_[a-f0-9]{32}$/.test(schema || "") ||
    !["reserved", "claimed", "unlinked"].includes(mode) ||
    !root ||
    !path.isAbsolute(root) ||
    !/^[0-9a-f-]{36}$/i.test(storageLocationId || "")
  ) {
    throw new Error("Invalid isolated crash test configuration");
  }

  const database = new DataSource({
    type: "postgres",
    url,
    schema,
    extra: { options: `-c search_path=${schema}` },
  });

  await database.initialize();

  const admission = new FileCopyAdmissionService(database);
  const sourcePath = path.join(root, "source.bin");
  const destinationPath = path.join(root, "destination.bin");

  const operationId = await admission.reserve({
    userId: 1,
    sourceFileId: 10,
    storageLocationId,
    relativeObjectKey: "destination.bin",
    bytes: fs.statSync(sourcePath).size,
  });

  if (mode === "reserved") {
    await notify("reserved", operationId);
    await park();
    return;
  }

  const storage = new StorageService(
    new ConfigService({
      STORAGE_PATH: root,
      NODE_ENV: "test",
    }),
  );

  const sourceFd = storage.openReadOnlyFileSecure(sourcePath);

  // The kernel closes descriptors when SIGKILL terminates this process.
  const lease = await storage.copyOpenedFileSecure(
    sourceFd,
    fs.fstatSync(sourceFd).size,
    destinationPath,
  );

  await admission.releaseAfterOwnedCleanup(
    operationId,
    1,
    async () => {
      if (mode === "claimed") {
        await notify("claimed", operationId);
        await park();
        return;
      }

      lease.cleanup();

      // The inode has been removed and its parent directory fsynced,
      // but the operation has not yet transitioned to released.
      await notify("unlinked", operationId);
      await park();
    },
  );

  throw new Error("Crash checkpoint unexpectedly completed");
}

main().catch((error) => {
  process.stderr.write(
    `Crash worker failed: ${error.stack || error}\n`,
  );
  process.exitCode = 1;
});
