import { randomUUID, createHash } from "crypto";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { ArchiveDownloadsService } from "./archive-downloads.service";
import { CreateArchiveDownloadCapabilities1792831200000 } from "../migrations/1792831200000-CreateArchiveDownloadCapabilities";
import { StorageService } from "../storage/storage.service";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
describeDatabase("private archive: real PostgreSQL manifest and ZIP", () => {
  const schema = `archive_${randomUUID().replace(/-/g, "")}`;
  let admin: DataSource;
  let db: DataSource;
  let service: ArchiveDownloadsService;
  let root: string;
  beforeAll(async () => {
    admin = new DataSource({ type: "postgres", url: databaseUrl });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({ type: "postgres", url: databaseUrl,
      extra: { options: `-c search_path=${schema}` } });
    await db.initialize();
    await db.query(`CREATE TABLE users (id integer PRIMARY KEY, "isActive" boolean NOT NULL)`);
    await db.query(`CREATE TABLE folders (id integer PRIMARY KEY, "parentId" integer, name text NOT NULL,
      "userId" integer NOT NULL, "isDeleted" boolean NOT NULL)`);
    await db.query(`CREATE TABLE files (id integer PRIMARY KEY, "parentId" integer, "folderId" integer,
      name text NOT NULL, "userId" integer NOT NULL, "isDeleted" boolean NOT NULL,
      "isFolder" boolean NOT NULL, size bigint, "storagePath" text,
      "storageLocationId" text, "relativeObjectKey" text)`);
    const runner = db.createQueryRunner();
    await new CreateArchiveDownloadCapabilities1792831200000().up(runner);
    await runner.release();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-archive-pg-")));
    fs.writeFileSync(path.join(root, "one.bin"), "first-data");
    fs.writeFileSync(path.join(root, "two.bin"), "second-data");
    const storage = {
      resolveFilePath: (member: { storagePath: string }) => member.storagePath,
      ensureWithinStorageRoot: (value: string) => {
        if (!value.startsWith(root + path.sep)) throw new Error("Outside storage");
        return value;
      },
    } as StorageService;
    service = new ArchiveDownloadsService(db, storage);
  }, 30000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE archive_download_capabilities, files, folders, users`);
    await db.query(`INSERT INTO users VALUES (1, true), (2, true)`);
    await db.query(`INSERT INTO folders VALUES
      (1, NULL, 'Project', 1, false), (2, 1, 'empty', 1, false),
      (3, 1, 'nested', 1, false), (4, NULL, 'Foreign', 2, false)`);
    await db.query(`INSERT INTO files VALUES
      (101, NULL, 1, 'Project', 1, false, true, 0, NULL, NULL, NULL),
      (102, 1, 2, 'empty', 1, false, true, 0, NULL, NULL, NULL),
      (103, 1, 3, 'nested', 1, false, true, 0, NULL, NULL, NULL),
      (104, NULL, 4, 'Foreign', 2, false, true, 0, NULL, NULL, NULL),
      (11, 1, NULL, 'one.txt', 1, false, false, 10, $1, NULL, NULL),
      (12, 3, NULL, 'two.txt', 1, false, false, 11, $2, NULL, NULL),
      (13, 4, NULL, 'secret.txt', 2, false, false, 10, $1, NULL, NULL)`,
      [path.join(root, "one.bin"), path.join(root, "two.bin")]);
  });

  it("streams mixed roots with empty folders, dedupes overlap and verifies ZIP bytes", async () => {
    const ticket = await service.prepare(1, [
      { kind: "file", id: 11 }, { kind: "folder", id: 1 }, { kind: "folder", id: 2 },
    ]);
    const { userId, manifest } = await service.authorize(ticket.id, ticket.token, true);
    const output = path.join(root, `${randomUUID()}.zip`);
    const destination = fs.createWriteStream(output);
    await service.stream(userId, manifest, destination);
    await new Promise<void>((resolve) => destination.end(resolve));
    const entries = execFileSync("unzip", ["-l", output], { encoding: "utf8" })
      .split("\n").map((line) => /^\s*\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((entry): entry is string => Boolean(entry));
    expect(entries).toContain("Project/empty/");
    expect(entries).toContain("Project/nested/two.txt");
    expect(entries.filter((entry) => entry === "Project/one.txt")).toHaveLength(1);
    expect(entries).not.toContain("one.txt");
    const unpacked = execFileSync("unzip", ["-p", output, "Project/nested/two.txt"]);
    expect(createHash("sha256").update(unpacked).digest("hex"))
      .toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "two.bin"))).digest("hex"));
    await expect(service.authorize(ticket.id, ticket.token, true)).rejects.toMatchObject({ status: 404 });
  });

  it("denies foreign roots and invalidates a prepared archive after deletion", async () => {
    await expect(service.prepare(1, [{ kind: "file", id: 13 }])).rejects.toMatchObject({ status: 404 });
    await expect(service.prepare(1, [{ kind: "folder", id: 4 }])).rejects.toMatchObject({ status: 404 });
    const ticket = await service.prepare(1, [{ kind: "folder", id: 1 }]);
    await db.query(`UPDATE files SET "isDeleted" = true WHERE id = 12`);
    const { userId, manifest } = await service.authorize(ticket.id, ticket.token, true);
    await expect(service.stream(userId, manifest, fs.createWriteStream(path.join(root, `${randomUUID()}.zip`))))
      .rejects.toMatchObject({ status: 409 });
  });
});
