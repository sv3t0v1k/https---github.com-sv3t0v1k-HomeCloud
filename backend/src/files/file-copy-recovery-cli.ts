import * as fs from "node:fs";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import applicationDatabase from "../data-source";
import { StorageService } from "../storage/storage.service";
import { releaseProvenAbsentOffline } from "./file-copy-offline-recovery";

const STATE_ROOT = "/run/homecloud/maintenance";
const MARKER = `${STATE_ROOT}/maintenance.inhibit`;

export function assertOfflineCopyRecoveryAllowed(): void {
  if (
    process.platform !== "linux" ||
    process.geteuid?.() === 0 ||
    process.env.HOMECLOUD_MAINTENANCE_REQUIRED !== "1" ||
    process.env.NODE_ENV !== "production" ||
    process.env.STORAGE_PATH !== "/storage" ||
    process.env.UPLOAD_SSD_ENABLED !== "false" ||
    process.env.UPLOAD_SSD_RECOVERY_MODE !== "manual"
  ) {
    throw new Error("Invalid offline copy recovery environment");
  }

  const root = fs.lstatSync(STATE_ROOT);

  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== 0 ||
    root.gid !== 0 ||
    (root.mode & 0o7777) !== 0o711 ||
    fs.realpathSync(STATE_ROOT) !== STATE_ROOT
  ) {
    throw new Error("Unsafe recovery maintenance directory");
  }

  const records = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields[4] === STATE_ROOT);

  if (
    records.length !== 1 ||
    !records[0][5].split(",").includes("ro")
  ) {
    throw new Error("Recovery maintenance mount must be readonly");
  }

  const marker = fs.lstatSync(MARKER);

  if (
    !marker.isFile() ||
    marker.isSymbolicLink() ||
    marker.uid !== 0 ||
    marker.gid !== 0 ||
    (marker.mode & 0o7777) !== 0o600 ||
    marker.nlink !== 1 ||
    marker.size !== Buffer.byteLength("homecloud-maintenance-v1\n")
  ) {
    throw new Error("Invalid offline recovery maintenance marker");
  }
}

async function main(): Promise<void> {
  if (
    process.argv.length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      process.argv[2],
    )
  ) {
    throw new Error("Exactly one copy operation UUID is required");
  }

  // Refuse before opening the database or storage service.
  assertOfflineCopyRecoveryAllowed();

  if (!process.env.DATABASE_URL) {
    throw new Error("Recovery database configuration missing");
  }

  let storage: StorageService | undefined;
  // This operator command has a separate offline admission and acquires
  // its own exclusive storage lock in releaseProvenAbsentOffline(). It
  // must not impersonate the API's inherited-lock startup contract.
  const database = new DataSource(applicationDatabase.options);

  try {
    storage = new StorageService(new ConfigService());

    await database.initialize();

    await releaseProvenAbsentOffline(
      database,
      storage,
      process.argv[2],
      assertOfflineCopyRecoveryAllowed,
    );
  } finally {
    try {
      if (database.isInitialized) {
        await database.destroy();
      }
    } finally {
      storage?.onModuleDestroy();
    }
  }

  console.log("COPY_RECOVERY_RELEASED");
}

if (require.main === module) {
  main().catch(() => {
    // Never disclose database credentials or raw SQL errors.
    console.error(
      "STOP: offline copy recovery failed; inspect journal before retry",
    );
    process.exitCode = 1;
  });
}
