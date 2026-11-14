import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { StorageService } from "../storage/storage.service";
import { SecureFilesystem } from "../uploads/secure-filesystem";
import { releaseProvenAbsentOffline } from "./file-copy-offline-recovery";
import { FileCopyAdmission1792831300000 } from "../migrations/1792831300000-FileCopyAdmission";
import { FileCopyAdmissionService } from "./file-copy-admission.service";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = url ? describe : describe.skip;

describePostgres("File copy admission PostgreSQL", () => {
  const schema = `copy_admission_${randomUUID().replace(/-/g, "")}`;
  const storageLocationId = "f2f5c4b0-8d57-4c49-9f8c-0d095b344601";

  let admin: DataSource;
  let db: DataSource;
  let service: FileCopyAdmissionService;

  const request = (userId: number, bytes = 100) => ({
    userId,
    sourceFileId: 10,
    storageLocationId,
    relativeObjectKey: `${userId}/${randomUUID()}.bin`,
    bytes,
  });

  beforeAll(async () => {
    admin = new DataSource({ type: "postgres", url });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);

    db = new DataSource({
      type: "postgres",
      url,
      schema,
      extra: { options: `-c search_path=${schema}` },
    });

    await db.initialize();

    await db.query(`
      CREATE TABLE users (
        id integer PRIMARY KEY,
        "isActive" boolean NOT NULL DEFAULT true,
        "storageUsed" bigint NOT NULL DEFAULT 0,
        "storageQuota" bigint NOT NULL DEFAULT 1000
      )
    `);

    await db.query(`
      CREATE TABLE storage_locations (
        id uuid PRIMARY KEY
      )
    `);

    await db.query(`
      CREATE TABLE files (
        id integer PRIMARY KEY,
        "userId" integer NOT NULL,
        "storageLocationId" uuid NOT NULL,
        "relativeObjectKey" varchar(500) NOT NULL,
        "storagePath" varchar(500),
        size bigint NOT NULL,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "isFolder" boolean NOT NULL DEFAULT false
      )
    `);

    await db.query(`
      CREATE TABLE upload_sessions (
        id serial PRIMARY KEY,
        "userId" integer NOT NULL REFERENCES users(id),
        status varchar(20) NOT NULL,
        "totalSize" bigint NOT NULL
      )
    `);

    await db.query(`INSERT INTO storage_locations (id) VALUES ($1)`, [
      storageLocationId,
    ]);

    await db.query(`
      INSERT INTO users (id)
      VALUES (1), (2), (3), (4), (5)
    `);

    const migration = new FileCopyAdmission1792831300000();
    const runner = db.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();
      await migration.up(runner);
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }

    service = new FileCopyAdmissionService(db);
  }, 30000);

  beforeEach(async () => {
    await db.query(`DELETE FROM files`);
    await db.query(`DELETE FROM file_copy_operations`);
    await db.query(`DELETE FROM upload_sessions`);
    await db.query(`
      UPDATE users SET
        "storageQuota" = 1000,
        "storageUsed" = 0,
        "isActive" = true
    `);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it("rejects exhausted quota before reserving bytes", async () => {
    await db.query(`UPDATE users SET "storageUsed" = 1000 WHERE id = 1`);

    await expect(service.reserve(request(1))).rejects.toThrow(
      "Storage quota exceeded",
    );

    const [row] = await db.query(
      `SELECT COUNT(*)::int AS count FROM file_copy_operations`,
    );

    expect(row.count).toBe(0);
  });

  it("accounts for existing upload reservations", async () => {
    await db.query(`
      INSERT INTO upload_sessions
        ("userId", status, "totalSize")
      VALUES (1, 'pending', 950)
    `);

    await expect(service.reserve(request(1, 100))).rejects.toThrow(
      "Storage quota exceeded",
    );

    await expect(service.reserve(request(1, 50))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("prevents a user from occupying multiple slots", async () => {
    await service.reserve(request(1));

    await expect(service.reserve(request(1))).rejects.toThrow(
      "User file copy already in progress",
    );

    await db.query(`
      UPDATE file_copy_operations
      SET state = 'cleanup_required'
      WHERE "userId" = 1
    `);

    await expect(service.reserve(request(1))).rejects.toThrow(
      "User file copy already in progress",
    );

    const [row] = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM file_copy_operations
      WHERE "userId" = 1
    `);

    expect(row.count).toBe(1);
  });

  it("enforces four global slots across service instances", async () => {
    const secondInstance = new FileCopyAdmissionService(db);

    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((userId, index) =>
        (index % 2 === 0 ? service : secondInstance).reserve(request(userId)),
      ),
    );

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      4,
    );

    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );

    const [row] = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM file_copy_operations
      WHERE state = 'reserved'
    `);

    expect(row.count).toBe(4);
  });

  it("recovers a committed reservation when COMMIT acknowledgement is lost", async () => {
    const originalFactory = db.createQueryRunner.bind(db);
    const spy = jest
      .spyOn(db, "createQueryRunner")
      .mockImplementation((...args) => {
        const runner = originalFactory(...args);
        const realCommit = runner.commitTransaction.bind(runner);

        runner.commitTransaction = async () => {
          await realCommit();
          throw new Error("commit acknowledgement lost");
        };

        return runner;
      });

    let operationId: string | undefined;

    try {
      operationId = await service.reserve(request(1));
    } finally {
      spy.mockRestore();
    }

    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.query(
      `SELECT id, state FROM file_copy_operations
       WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ id: operationId, state: "reserved" }]);
  });

  it("rejects reservation when COMMIT is rolled back", async () => {
    const originalFactory = db.createQueryRunner.bind(db);

    const spy = jest
      .spyOn(db, "createQueryRunner")
      .mockImplementation((...args) => {
        const runner = originalFactory(...args);

        runner.commitTransaction = async () => {
          await runner.rollbackTransaction();
          throw new Error("commit failed before persistence");
        };

        return runner;
      });

    try {
      await expect(service.reserve(request(1))).rejects.toThrow(
        "Copy reservation COMMIT not confirmed",
      );
    } finally {
      spy.mockRestore();
    }

    const [row] = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM file_copy_operations
       WHERE "userId" = 1`,
    );

    expect(row.count).toBe(0);
  });

  it("preserves uncertain reservation when reconciliation is unavailable", async () => {
    const originalFactory = db.createQueryRunner.bind(db);

    const factorySpy = jest
      .spyOn(db, "createQueryRunner")
      .mockImplementation((...args) => {
        const runner = originalFactory(...args);
        const realCommit = runner.commitTransaction.bind(runner);

        runner.commitTransaction = async () => {
          await realCommit();
          throw new Error("commit acknowledgement lost");
        };

        return runner;
      });

    // reserve() uses runner.query for admission.
    // The first DataSource.query is the reconciliation lookup.
    const querySpy = jest
      .spyOn(db, "query")
      .mockRejectedValueOnce(new Error("reconciliation database unavailable"));

    try {
      await expect(service.reserve(request(1))).rejects.toThrow(
        "Copy reservation COMMIT outcome uncertain",
      );
    } finally {
      querySpy.mockRestore();
      factorySpy.mockRestore();
    }

    const rows = await db.query(
      `SELECT state, bytes::text AS bytes
       FROM file_copy_operations
       WHERE "userId" = 1`,
    );

    expect(rows).toEqual([{ state: "reserved", bytes: "100" }]);

    await expect(service.reserve(request(1))).rejects.toThrow(
      "User file copy already in progress",
    );
  });

  it("publishes a matching copy and its reservation atomically", async () => {
    const placement = request(1, 100);
    const operationId = await service.reserve(placement);

    await db.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO files (
          id, "userId", "storageLocationId",
          "relativeObjectKey", size
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          701,
          placement.userId,
          placement.storageLocationId,
          placement.relativeObjectKey,
          placement.bytes,
        ],
      );

      await manager.query(
        `UPDATE users
         SET "storageUsed" = "storageUsed" + 100
         WHERE id = 1`,
      );

      await service.markCommitted(manager, operationId, 1, 701);
    });

    const rows = await db.query(
      `SELECT state, "resultFileId"
       FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ state: "committed", resultFileId: 701 }]);

    const [owner] = await db.query(
      `SELECT "storageUsed"::text AS used FROM users WHERE id = 1`,
    );
    expect(owner.used).toBe("100");
  });

  it("rolls back publication when copy placement does not match", async () => {
    const placement = request(1, 100);
    const operationId = await service.reserve(placement);

    await expect(
      db.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO files (
            id, "userId", "storageLocationId",
            "relativeObjectKey", size
          ) VALUES ($1, $2, $3, $4, $5)`,
          [
            702,
            placement.userId,
            placement.storageLocationId,
            "different-object.bin",
            placement.bytes,
          ],
        );

        await manager.query(
          `UPDATE users
           SET "storageUsed" = "storageUsed" + 100
           WHERE id = 1`,
        );

        await service.markCommitted(manager, operationId, 1, 702);
      }),
    ).rejects.toThrow("Copy reservation publication mismatch");

    const [operation] = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(operation.state).toBe("reserved");

    const [owner] = await db.query(
      `SELECT "storageUsed"::text AS used FROM users WHERE id = 1`,
    );
    expect(owner.used).toBe("0");

    const [files] = await db.query(
      `SELECT COUNT(*)::int AS count FROM files WHERE id = 702`,
    );
    expect(files.count).toBe(0);
  });

  it("releases a reservation only after owned cleanup succeeds", async () => {
    const operationId = await service.reserve(request(1));
    const cleanup = jest.fn();

    await service.releaseAfterOwnedCleanup(operationId, 1, cleanup);

    expect(cleanup).toHaveBeenCalledTimes(1);

    const rows = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ state: "released" }]);

    await expect(service.reserve(request(1))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("retains quota and user slot when owned cleanup fails", async () => {
    const operationId = await service.reserve(request(1, 900));

    await expect(
      service.releaseAfterOwnedCleanup(operationId, 1, () => {
        throw new Error("owned inode cleanup failed");
      }),
    ).rejects.toThrow("owned inode cleanup failed");

    const rows = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ state: "cleanup_required" }]);

    await expect(service.reserve(request(1, 100))).rejects.toThrow(
      "User file copy already in progress",
    );

    await service.releaseAfterOwnedCleanup(operationId, 1, () => undefined);

    const after = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(after).toEqual([{ state: "released" }]);
  });

  it("never invokes cleanup for committed copy metadata", async () => {
    const placement = request(1);
    const operationId = await service.reserve(placement);

    await db.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO files (
          id, "userId", "storageLocationId",
          "relativeObjectKey", size
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          801,
          placement.userId,
          placement.storageLocationId,
          placement.relativeObjectKey,
          placement.bytes,
        ],
      );

      await service.markCommitted(manager, operationId, 1, 801);
    });

    const cleanup = jest.fn();

    await expect(
      service.releaseAfterOwnedCleanup(operationId, 1, cleanup),
    ).rejects.toThrow("Copy cleanup not authorized");

    expect(cleanup).not.toHaveBeenCalled();

    const rows = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ state: "committed" }]);
  });

  it("refuses cleanup when caller does not own the reservation", async () => {
    const operationId = await service.reserve(request(1));
    const cleanup = jest.fn();

    await expect(
      service.releaseAfterOwnedCleanup(operationId, 2, cleanup),
    ).rejects.toThrow("Copy cleanup not authorized");

    expect(cleanup).not.toHaveBeenCalled();

    const rows = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(rows).toEqual([{ state: "reserved" }]);
  });

  it("inspects an unresolved reservation through a new service instance", async () => {
    const operationId = await service.reserve(request(1, 100));
    const reopened = new FileCopyAdmissionService(db);

    const rows = await reopened.inspectUnresolved();

    expect(rows).toEqual([
      expect.objectContaining({
        id: operationId,
        userId: 1,
        bytes: "100",
        state: "reserved",
        metadataPresent: false,
      }),
    ]);

    await expect(reopened.reserve(request(1, 100))).rejects.toThrow(
      "User file copy already in progress",
    );

    const [operation] = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );
    expect(operation.state).toBe("reserved");
  });

  it("reports failed cleanup without releasing its reservation", async () => {
    const operationId = await service.reserve(request(1, 100));

    await expect(
      service.releaseAfterOwnedCleanup(operationId, 1, () => {
        throw new Error("injected cleanup failure");
      }),
    ).rejects.toThrow("injected cleanup failure");

    const reopened = new FileCopyAdmissionService(db);
    const rows = await reopened.inspectUnresolved();

    expect(rows).toEqual([
      expect.objectContaining({
        id: operationId,
        state: "cleanup_required",
        metadataPresent: false,
      }),
    ]);

    const [operation] = await db.query(
      `SELECT state FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );
    expect(operation.state).toBe("cleanup_required");
  });

  it("rejects unbounded recovery audit queries", async () => {
    await expect(service.inspectUnresolved(0)).rejects.toThrow(
      "Invalid copy audit limit",
    );
    await expect(service.inspectUnresolved(101)).rejects.toThrow(
      "Invalid copy audit limit",
    );
  });

  it("prevents simultaneous cleanup callbacks across service instances", async () => {
    const operationId = await service.reserve(request(1, 100));
    const second = new FileCopyAdmissionService(db);

    let signalStarted!: () => void;
    let resume!: () => void;

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });

    const firstCleanup = jest.fn(async () => {
      signalStarted();
      await paused;
    });
    const secondCleanup = jest.fn();

    const first = service.releaseAfterOwnedCleanup(
      operationId,
      1,
      firstCleanup,
    );

    await started;

    try {
      await expect(
        second.releaseAfterOwnedCleanup(operationId, 1, secondCleanup),
      ).rejects.toThrow("Copy cleanup not authorized");

      expect(secondCleanup).not.toHaveBeenCalled();

      const [operation] = await db.query(
        `SELECT state, "cleanupClaimId"
         FROM file_copy_operations WHERE id = $1`,
        [operationId],
      );

      expect(operation.state).toBe("cleanup_required");
      expect(operation.cleanupClaimId).toMatch(/^[0-9a-f-]{36}$/i);

      const audit = await second.inspectUnresolved();
      expect(audit).toEqual([
        expect.objectContaining({
          id: operationId,
          cleanupClaimed: true,
        }),
      ]);

      await expect(second.reserve(request(1, 100))).rejects.toThrow(
        "User file copy already in progress",
      );
    } finally {
      resume();
      await first;
    }

    expect(firstCleanup).toHaveBeenCalledTimes(1);

    const [released] = await db.query(
      `SELECT state, "cleanupClaimId"
       FROM file_copy_operations WHERE id = $1`,
      [operationId],
    );

    expect(released).toEqual({
      state: "released",
      cleanupClaimId: null,
    });
  });

  const crashPhases = [
    ["reserved", "reserved", false, false],
    ["claimed", "cleanup_required", true, true],
    ["unlinked", "cleanup_required", true, false],
  ] as const;

  (process.platform === "linux" ? describe : describe.skip)(
    "real SIGKILL crash checkpoints",
    () => {
      it.each(crashPhases)(
        "holds a reservation after real SIGKILL at %s",
        async (phase, expectedState, expectedClaim, expectedDestination) => {
          const root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), "hc-copy-sigkill-")),
          );
          const sourcePath = path.join(root, "source.bin");
          const destinationPath = path.join(root, "destination.bin");
          const sourceBytes = Buffer.alloc(256, 0x5a);
          fs.writeFileSync(sourcePath, sourceBytes);

          const workerPath = path.resolve(
            __dirname,
            "../../test/file-copy-crash-worker.cjs",
          );

          const child = fork(workerPath, [], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              HOMECLOUD_TEST_DATABASE_URL: url ?? "",
              HOMECLOUD_COPY_CRASH_SCHEMA: schema,
              HOMECLOUD_COPY_CRASH_MODE: phase,
              HOMECLOUD_COPY_CRASH_ROOT: root,
              HOMECLOUD_COPY_CRASH_STORAGE_LOCATION_ID: storageLocationId,
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });

          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4000);
          });

          const exited = new Promise<{
            code: number | null;
            signal: string | null;
          }>((resolve) => {
            child.once("exit", (code, signal) => {
              resolve({ code, signal });
            });
          });

          try {
            const operationId = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error(`Crash worker timeout: ${stderr}`));
              }, 15000);

              child.once("message", (message: unknown) => {
                clearTimeout(timeout);

                const event = message as {
                  phase?: string;
                  operationId?: string;
                };

                if (
                  event?.phase !== phase ||
                  !/^[0-9a-f-]{36}$/i.test(event?.operationId ?? "")
                ) {
                  reject(new Error("Unexpected crash checkpoint"));
                  return;
                }

                resolve(event.operationId!);
              });

              child.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
              });

              child.once("exit", (code, signal) => {
                clearTimeout(timeout);
                reject(
                  new Error(
                    `Crash worker exited early: ${code}/${signal} ${stderr}`,
                  ),
                );
              });
            });

            // Only this newly spawned test worker may be terminated.
            expect(child.kill("SIGKILL")).toBe(true);

            const termination = await Promise.race([
              exited,
              new Promise<never>((_, reject) => {
                const timeout = setTimeout(() => {
                  reject(new Error("SIGKILL did not terminate worker"));
                }, 5000);
                timeout.unref();
              }),
            ]);

            expect(termination.signal).toBe("SIGKILL");

            // Reopen journal access after the worker is dead.
            const reopened = new FileCopyAdmissionService(db);
            const [record] = await db.query(
              `SELECT state, "cleanupClaimId", "relativeObjectKey"
           FROM file_copy_operations WHERE id = $1`,
              [operationId],
            );

            expect(record).toBeDefined();
            expect(record.state).toBe(expectedState);
            expect(record.relativeObjectKey).toBe("destination.bin");
            expect(record.cleanupClaimId !== null).toBe(expectedClaim);

            expect(fs.existsSync(destinationPath)).toBe(expectedDestination);
            expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);

            const audit = await reopened.inspectUnresolved();
            expect(audit).toEqual([
              expect.objectContaining({
                id: operationId,
                state: expectedState,
                cleanupClaimed: expectedClaim,
                metadataPresent: false,
              }),
            ]);

            // A killed worker cannot silently free quota/user capacity.
            await expect(reopened.reserve(request(1, 100))).rejects.toThrow(
              "User file copy already in progress",
            );

            const forbiddenCleanup = jest.fn();
            const cleanupOutcome = expectedClaim
              ? await reopened
                  .releaseAfterOwnedCleanup(operationId, 1, forbiddenCleanup)
                  .then(
                    () => "unexpected success",
                    (error: unknown) =>
                      error instanceof Error ? error.message : String(error),
                  )
              : "not attempted";

            expect(cleanupOutcome).toBe(
              expectedClaim ? "Copy cleanup not authorized" : "not attempted",
            );
            expect(forbiddenCleanup).not.toHaveBeenCalled();

            const [stillReserved] = await db.query(
              `SELECT state, "cleanupClaimId"
           FROM file_copy_operations WHERE id = $1`,
              [operationId],
            );

            expect(stillReserved.state).toBe(expectedState);
            expect(stillReserved.cleanupClaimId !== null).toBe(expectedClaim);
          } finally {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }

            await exited;

            // Remove only this test's freshly created isolated directory.
            fs.rmSync(root, { recursive: true, force: true });
          }
        },
        30000,
      );
    },
  );

  const describeOfflineLinux =
    process.platform === "linux" ? describe : describe.skip;

  describeOfflineLinux("offline absent-copy recovery", () => {
    let recoveryRoot: string;
    let recoveryStorage: StorageService;

    beforeEach(() => {
      recoveryRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "hc-copy-recovery-")),
      );
      fs.mkdirSync(path.join(recoveryRoot, "1"), { mode: 0o700 });

      recoveryStorage = new StorageService(
        new ConfigService({
          STORAGE_PATH: recoveryRoot,
          NODE_ENV: "test",
        }),
      );
    });

    afterEach(() => {
      recoveryStorage?.onModuleDestroy();
      fs.rmSync(recoveryRoot, { recursive: true, force: true });
      jest.restoreAllMocks();
    });

    const reserveAt = async (key: string) =>
      service.reserve({
        ...request(1, 50),
        relativeObjectKey: key,
      });

    it("releases an absent reserved destination", async () => {
      const key = `1/${randomUUID()}.bin`;
      const id = await reserveAt(key);

      await releaseProvenAbsentOffline(db, recoveryStorage, id);

      const [row] = await db.query(
        `SELECT state, "cleanupClaimId"
         FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(row).toEqual({
        state: "released",
        cleanupClaimId: null,
      });

      await expect(service.reserve(request(1, 50))).resolves.toBeDefined();
    });

    it("releases an absent destination with a stale claim", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);

      await db.query(
        `UPDATE file_copy_operations
         SET state = 'cleanup_required',
             "cleanupClaimId" = $2::uuid
         WHERE id = $1`,
        [id, randomUUID()],
      );

      await releaseProvenAbsentOffline(db, recoveryStorage, id);

      const [row] = await db.query(
        `SELECT state, "cleanupClaimId"
         FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(row.state).toBe("released");
      expect(row.cleanupClaimId).toBeNull();
    });

    it("refuses an existing inode without changing it", async () => {
      const key = `1/${randomUUID()}.bin`;
      const id = await reserveAt(key);
      const destination = path.join(recoveryRoot, key);

      fs.writeFileSync(destination, "protected inode");

      await expect(
        releaseProvenAbsentOffline(db, recoveryStorage, id),
      ).rejects.toThrow("Copy destination exists");

      expect(fs.readFileSync(destination, "utf8")).toBe("protected inode");

      const [row] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );
      expect(row.state).toBe("reserved");
    });

    it("refuses metadata referencing a physically absent file", async () => {
      const key = `1/${randomUUID()}.bin`;
      const id = await reserveAt(key);

      await db.query(
        `INSERT INTO files (
          id, "userId", "storageLocationId",
          "relativeObjectKey", "storagePath",
          size, "isDeleted", "isFolder"
        ) VALUES (77777, 1, $1, $2, $3, 50, true, false)`,
        [storageLocationId, key, path.join(recoveryRoot, key)],
      );

      await expect(
        releaseProvenAbsentOffline(db, recoveryStorage, id),
      ).rejects.toThrow("Copy recovery metadata still references destination");

      const [row] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );
      expect(row.state).toBe("reserved");
    });

    it("retains reservation if directory fsync fails", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);

      const mutableFs = fs;
      const sync = jest.spyOn(mutableFs, "fsyncSync").mockImplementation(() => {
        throw new Error("Injected directory fsync failure");
      });

      try {
        await expect(
          releaseProvenAbsentOffline(db, recoveryStorage, id),
        ).rejects.toThrow("Injected directory fsync failure");
      } finally {
        sync.mockRestore();
      }

      const [row] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );
      expect(row.state).toBe("reserved");
    });

    it("preserves a committed release after lost COMMIT acknowledgement", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);
      const create = db.createQueryRunner.bind(db);
      const inject = jest
        .spyOn(db, "createQueryRunner")
        .mockImplementation((mode) => {
          const runner = create(mode);
          const commit = runner.commitTransaction.bind(runner);
          runner.commitTransaction = async () => {
            await commit();
            throw new Error("Injected lost recovery COMMIT acknowledgement");
          };
          return runner;
        });

      try {
        await expect(
          releaseProvenAbsentOffline(db, recoveryStorage, id),
        ).rejects.toThrow("Injected lost recovery COMMIT acknowledgement");
      } finally {
        inject.mockRestore();
      }

      const [row] = await db.query(
        `SELECT state, "cleanupClaimId"
         FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(row).toEqual({ state: "released", cleanupClaimId: null });

      await expect(
        releaseProvenAbsentOffline(db, recoveryStorage, id),
      ).rejects.toThrow("Copy recovery state is not releasable");
    });

    it("retains a reservation when recovery COMMIT is rolled back", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);
      const create = db.createQueryRunner.bind(db);
      const inject = jest
        .spyOn(db, "createQueryRunner")
        .mockImplementation((mode) => {
          const runner = create(mode);
          runner.commitTransaction = async () => {
            await runner.rollbackTransaction();
            throw new Error("Injected recovery COMMIT rollback");
          };
          return runner;
        });

      try {
        await expect(
          releaseProvenAbsentOffline(db, recoveryStorage, id),
        ).rejects.toThrow("Injected recovery COMMIT rollback");
      } finally {
        inject.mockRestore();
      }

      const [row] = await db.query(
        `SELECT state, "cleanupClaimId"
         FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(row).toEqual({ state: "reserved", cleanupClaimId: null });
    });

    it("recovery is blocked by a competing root lock", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);

      const holder = new SecureFilesystem(
        recoveryRoot,
        fs.lstatSync(recoveryRoot),
      );
      const fd = holder.directory(recoveryRoot);

      try {
        holder.lock(fd);

        await expect(
          releaseProvenAbsentOffline(db, recoveryStorage, id),
        ).rejects.toThrow();

        const [row] = await db.query(
          `SELECT state, "cleanupClaimId"
           FROM file_copy_operations WHERE id = $1`,
          [id],
        );

        expect(row).toEqual({
          state: "reserved",
          cleanupClaimId: null,
        });
      } finally {
        fs.closeSync(fd);
        holder.close();
      }

      await expect(
        releaseProvenAbsentOffline(db, recoveryStorage, id),
      ).resolves.toBeUndefined();

      const [released] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(released.state).toBe("released");
    });

    it("releases the recovery root lock after successful COMMIT", async () => {
      const id = await reserveAt(`1/${randomUUID()}.bin`);

      await releaseProvenAbsentOffline(db, recoveryStorage, id);

      const observer = new SecureFilesystem(
        recoveryRoot,
        fs.lstatSync(recoveryRoot),
      );
      const fd = observer.directory(recoveryRoot);

      try {
        expect(() => observer.lock(fd)).not.toThrow();
      } finally {
        fs.closeSync(fd);
        observer.close();
      }

      const [row] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );

      expect(row.state).toBe("released");
    });

    it("refuses a journal path belonging to another user", async () => {
      const id = await reserveAt(`2/${randomUUID()}.bin`);

      await expect(
        releaseProvenAbsentOffline(db, recoveryStorage, id),
      ).rejects.toThrow("Copy recovery placement ownership mismatch");

      const [row] = await db.query(
        `SELECT state FROM file_copy_operations WHERE id = $1`,
        [id],
      );
      expect(row.state).toBe("reserved");
    });
  });

  it("rejects already aborted admission", async () => {
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      service.reserve({
        ...request(1),
        signal: cancellation.signal,
      }),
    ).rejects.toThrow("File copy cancelled");

    const [row] = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM file_copy_operations
    `);

    expect(row.count).toBe(0);
  });
});
