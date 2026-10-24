import { createHash } from "crypto";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutionContext, INestApplication, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ArchiveDownloadsService, ArchiveSelection } from "./archive-downloads.service";
import { ArchivePrepareController, NativeArchiveController } from "./archive-downloads.controller";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { StorageService } from "../storage/storage.service";
import { streamArchiveMembers } from "../common/archive-stream";

type Folder = { id: number; parentId: number | null; name: string; userId: number; isDeleted: boolean; mirrorId: number };
type File = { id: number; parentId: number | null; name: string; userId: number; isDeleted: boolean; isFolder: boolean; size: number; storagePath: string | null; storageLocationId: null; relativeObjectKey: null };

describe("private selection ZIP", () => {
  let root: string;
  let folders: Folder[];
  let files: File[];
  let grants: Map<string, { tokenHash: string; userId: number; manifest: unknown }>;
  let service: ArchiveDownloadsService;

  const addFile = (id: number, name: string, parentId: number | null, content: string, userId = 1) => {
    const storagePath = path.join(root, `${id}.bin`);
    fs.writeFileSync(storagePath, content);
    files.push({ id, parentId, name, userId, isDeleted: false, isFolder: false,
      size: Buffer.byteLength(content), storagePath, storageLocationId: null, relativeObjectKey: null });
  };
  const selection = (...items: ArchiveSelection[]) => items;
  const file = (id: number): ArchiveSelection => ({ kind: "file", id });
  const folder = (id: number): ArchiveSelection => ({ kind: "folder", id });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-archive-test-")));
    folders = [
      { id: 1, parentId: null, name: "Project", userId: 1, isDeleted: false, mirrorId: 101 },
      { id: 2, parentId: 1, name: "nested", userId: 1, isDeleted: false, mirrorId: 102 },
      { id: 3, parentId: 1, name: "empty", userId: 1, isDeleted: false, mirrorId: 103 },
      { id: 4, parentId: null, name: "Project", userId: 1, isDeleted: false, mirrorId: 104 },
      { id: 5, parentId: null, name: "private", userId: 2, isDeleted: false, mirrorId: 105 },
    ];
    files = [];
    addFile(11, "alpha.txt", 1, "alpha payload");
    addFile(12, "beta.txt", 2, "beta payload");
    addFile(13, "alpha.txt", null, "top-level payload");
    addFile(14, "secret.txt", 5, "not yours", 2);
    grants = new Map();
    const query = async (sql: string, args: unknown[] = []): Promise<any> => {
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("DELETE FROM archive_download_capabilities WHERE")) return [];
      if (sql.includes("COUNT(*)::int AS total")) return [{ total: grants.size, own: grants.size }];
      if (sql.includes("INSERT INTO archive_download_capabilities")) {
        grants.set(String(args[0]), { tokenHash: String(args[1]), userId: Number(args[2]), manifest: JSON.parse(String(args[3])) });
        return [];
      }
      if (sql.includes("FROM archive_download_capabilities c WHERE") || sql.includes("DELETE FROM archive_download_capabilities c")) {
        const grant = grants.get(String(args[0]));
        if (!grant || grant.tokenHash !== args[1]) return [];
        if (sql.includes("DELETE FROM")) grants.delete(String(args[0]));
        return [{ userId: grant.userId, manifest: grant.manifest }];
      }
      if (sql.includes("WITH RECURSIVE chain")) {
        const result: Array<Folder & { depth: number }> = [];
        let current = folders.find((value) => value.id === args[0]);
        while (current) {
          result.push({ ...current, depth: result.length });
          current = folders.find((value) => value.id === current!.parentId);
        }
        return result;
      }
      if (sql.includes("WITH RECURSIVE tree")) {
        const result: Array<Folder & { depth: number }> = [];
        const visit = (id: number, depth: number) => {
          const item = folders.find((value) => value.id === id && value.userId === args[1] && !value.isDeleted);
          if (!item) return;
          result.push({ ...item, depth });
          folders.filter((value) => value.parentId === id).forEach((value) => visit(value.id, depth + 1));
        };
        visit(Number(args[0]), 0);
        return result.sort((a, b) => a.depth - b.depth || a.id - b.id);
      }
      if (sql.includes("FROM files WHERE id ="))
        return files.filter((value) => value.id === args[0] && value.userId === args[1]);
      if (sql.includes('"parentId" = ANY'))
        return files.filter((value) => (args[0] as number[]).includes(value.parentId!) && value.userId === args[1] && !value.isDeleted && !value.isFolder);
      throw new Error(`Unexpected query: ${sql}`);
    };
    const db = { query, transaction: async (work: (manager: { query: typeof query }) => Promise<unknown>) => work({ query }) } as unknown as DataSource;
    const storage = {
      resolveFilePath: (member: File) => {
        if (!member.storagePath || !path.resolve(member.storagePath).startsWith(root + path.sep)) throw new Error("Outside root");
        return member.storagePath;
      },
      ensureWithinStorageRoot: (value: string) => {
        if (!path.resolve(value).startsWith(root + path.sep)) throw new Error("Outside root");
        return value;
      },
    } as unknown as StorageService;
    service = new ArchiveDownloadsService(db, storage);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const download = async (items: ArchiveSelection[]) => {
    const grant = await service.prepare(1, items);
    const { userId, manifest } = await service.authorize(grant.id, grant.token, true);
    const output = path.join(root, "result.zip");
    const destination = fs.createWriteStream(output);
    await service.stream(userId, manifest, destination);
    await new Promise<void>((resolve) => destination.end(resolve));
    const entries = execFileSync("unzip", ["-l", output], { encoding: "utf8" })
      .split("\n").map((line) => /^\s*\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((entry): entry is string => Boolean(entry));
    const content = (entry: string) => execFileSync("unzip", ["-p", output, entry]);
    return { entries, content, grant, manifest };
  };

  it("archives one file byte-for-byte and preserves its SHA-256", async () => {
    const zip = await download(selection(file(11)));
    expect(zip.entries).toEqual(["alpha.txt"]);
    expect(createHash("sha256").update(zip.content("alpha.txt")).digest("hex"))
      .toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "11.bin"))).digest("hex"));
  });

  it("archives multiple files and mixed roots with nested and empty folders", async () => {
    const zip = await download(selection(file(13), folder(1), folder(4)));
    expect(zip.entries).toEqual(expect.arrayContaining([
      "Project/", "Project/nested/", "Project/empty/", "Project/alpha.txt",
      "Project/nested/beta.txt", "Project (2)/", "alpha.txt",
    ]));
    expect(zip.entries).toHaveLength(7);
    expect(zip.content("Project/nested/beta.txt")).toEqual(Buffer.from("beta payload"));
  });

  it("deduplicates selected ancestors, descendants and files within folders", async () => {
    const zip = await download(selection(folder(2), file(12), folder(1), file(11)));
    expect(zip.entries.filter((entry) => entry.endsWith("beta.txt"))).toHaveLength(1);
    expect(zip.entries).not.toContain("nested/");
    expect(zip.entries).not.toContain("beta.txt");
  });

  it("renames colliding top-level roots and refuses collisions inside a folder", async () => {
    const zip = await download(selection(folder(1), folder(4)));
    expect(zip.entries).toContain("Project/");
    expect(zip.entries).toContain("Project (2)/");
    addFile(15, "ALPHA.TXT", 1, "collision");
    await expect(service.prepare(1, selection(folder(1)))).rejects.toMatchObject({ status: 409 });
  });

  it("denies foreign, deleted, renamed and removed selections", async () => {
    await expect(service.prepare(1, selection(file(14)))).rejects.toMatchObject({ status: 404 });
    await expect(service.prepare(1, selection(folder(5)))).rejects.toMatchObject({ status: 404 });
    files.find((item) => item.id === 11)!.isDeleted = true;
    await expect(service.prepare(1, selection(file(11)))).rejects.toMatchObject({ status: 404 });
    files.find((item) => item.id === 11)!.isDeleted = false;
    const grant = await service.prepare(1, selection(folder(1)));
    const consumed = await service.authorize(grant.id, grant.token, true);
    files.find((item) => item.id === 12)!.name = "changed.txt";
    await expect(service.stream(consumed.userId, consumed.manifest, new PassThrough())).rejects.toMatchObject({ status: 409 });
  });

  it("refuses unsafe names, outside paths and symlink escape", async () => {
    files.find((item) => item.id === 11)!.name = "../escape";
    await expect(service.prepare(1, selection(file(11)))).rejects.toMatchObject({ status: 400 });
    files.find((item) => item.id === 11)!.name = "alpha.txt";
    files.find((item) => item.id === 11)!.storagePath = path.join(os.tmpdir(), "outside.bin");
    await expect(service.prepare(1, selection(file(11)))).rejects.toMatchObject({ status: 404 });
    const link = path.join(root, "escape-link");
    fs.symlinkSync(path.join(os.tmpdir(), "outside.bin"), link);
    files.find((item) => item.id === 11)!.storagePath = link;
    await expect(service.prepare(1, selection(file(11)))).rejects.toMatchObject({ status: 404 });
  });

  it("enforces root count, object size and total size caps", async () => {
    await expect(service.prepare(1, Array.from({ length: 33 }, () => file(11)))).rejects.toMatchObject({ status: 400 });
    files.find((item) => item.id === 11)!.size = 100 * 1024 ** 3 + 1;
    await expect(service.prepare(1, selection(file(11)))).rejects.toMatchObject({ status: 400 });
    files.find((item) => item.id === 11)!.size = 80 * 1024 ** 3;
    files.find((item) => item.id === 13)!.size = 30 * 1024 ** 3;
    await expect(service.prepare(1, selection(file(11), file(13)))).rejects.toMatchObject({ status: 400 });
  });

  it("consumes capabilities exactly once and rejects a forged token", async () => {
    const grant = await service.prepare(1, selection(file(11)));
    await expect(service.authorize(grant.id, "0".repeat(64), true)).rejects.toMatchObject({ status: 404 });
    await service.authorize(grant.id, grant.token, true);
    await expect(service.authorize(grant.id, grant.token, true)).rejects.toMatchObject({ status: 404 });
    expect(grants.size).toBe(0);
  });

  it("keeps the capability after native HEAD and consumes it on GET", async () => {
    const module = await Test.createTestingModule({
      controllers: [ArchivePrepareController, NativeArchiveController],
      providers: [
        { provide: ArchiveDownloadsService, useValue: service },
        { provide: ConfigService, useValue: new ConfigService({ NODE_ENV: "test" }) },
      ],
    }).overrideGuard(JwtGuard).useValue({
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        if (req.headers.authorization !== "Bearer owner") throw new UnauthorizedException();
        req.user = { userId: 1 };
        return true;
      },
    }).compile();
    const app: INestApplication = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    try {
      const prepared = await request(app.getHttpServer())
        .post("/api/v1/files/download-archives/prepare")
        .set("Authorization", "Bearer owner")
        .send({ items: [file(11)] }).expect(200);
      const cookie = String(prepared.headers["set-cookie"][0]).split(";")[0];
      const url = `/api/v1${prepared.body.downloadPath}`;
      expect(prepared.headers["set-cookie"][0]).toContain("HttpOnly");
      expect(prepared.headers["set-cookie"][0]).toContain("SameSite=Strict");
      await request(app.getHttpServer()).head(url).set("Cookie", cookie).expect(200);
      expect(grants.size).toBe(1);
      const downloaded = await request(app.getHttpServer()).get(url).set("Cookie", cookie).expect(200);
      expect(downloaded.headers["x-accel-buffering"]).toBe("no");
      expect(grants.size).toBe(0);
      await request(app.getHttpServer()).get(url).set("Cookie", cookie).expect(404);
    } finally { await app.close(); }
  });

  it("refuses a removed file or a changed folder after ticket issuance", async () => {
    const fileGrant = await service.prepare(1, selection(file(11)));
    const fileManifest = await service.authorize(fileGrant.id, fileGrant.token, true);
    const folderGrant = await service.prepare(1, selection(folder(1)));
    const folderManifest = await service.authorize(folderGrant.id, folderGrant.token, true);
    fs.unlinkSync(path.join(root, "11.bin"));
    await expect(service.stream(fileManifest.userId, fileManifest.manifest, new PassThrough()))
      .rejects.toMatchObject({ status: 404 });

    folders.find((item) => item.id === 2)!.isDeleted = true;
    await expect(service.stream(folderManifest.userId, folderManifest.manifest, new PassThrough()))
      .rejects.toMatchObject({ status: 409 });
  });

  it("stops a large stream when the client closes the connection", async () => {
    const large = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    fs.writeFileSync(path.join(root, "11.bin"), large);
    files.find((item) => item.id === 11)!.size = large.length;
    const grant = await service.prepare(1, selection(file(11)));
    const { userId, manifest } = await service.authorize(grant.id, grant.token, true);
    const client = new PassThrough({ highWaterMark: 1024 });
    let received = 0;
    client.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > 1024) client.destroy();
    });
    await service.stream(userId, manifest, client);
    expect(client.destroyed).toBe(true);
    expect(received).toBeLessThan(large.length);
  });

  it("stops when the client disconnects during the manifest preflight", async () => {
    const grant = await service.prepare(1, selection(file(11)));
    const { userId, manifest } = await service.authorize(grant.id, grant.token, true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const preflight = jest.spyOn(service as any, "preflight").mockImplementation(async () => {
      entered();
      await gate;
    });
    const client = new PassThrough();
    const running = service.stream(userId, manifest, client);
    await pending;
    client.destroy();
    release();
    await expect(running).resolves.toBeUndefined();
    expect(client.readableLength).toBe(0);
    preflight.mockRestore();
  });

  it("stops checking further files after a preflight disconnect", async () => {
    const grant = await service.prepare(1, selection(file(11), file(13)));
    const { userId, manifest } = await service.authorize(grant.id, grant.token, true);
    const client = new PassThrough();
    const storage = (service as any).storage as StorageService;
    const original = storage.resolveFilePath.bind(storage);
    let checked = 0;
    const resolve = jest.spyOn(storage, "resolveFilePath").mockImplementation((member) => {
      checked++;
      if (checked === 1) client.destroy();
      return original(member);
    });
    await expect(service.stream(userId, manifest, client)).resolves.toBeUndefined();
    expect(checked).toBe(1);
    resolve.mockRestore();
  });

  it("closes a pending descriptor when the client disconnects during revalidation", async () => {
    const member = files.find((item) => item.id === 11)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const client = new PassThrough();
    const running = streamArchiveMembers([{
      logicalPath: member.name, isFolder: false, storagePath: member.storagePath,
      storageLocationId: null, relativeObjectKey: null, size: member.size,
    }], {
      resolveFilePath: () => member.storagePath!,
      ensureWithinStorageRoot: (value: string) => value,
    } as unknown as StorageService, client, {
      pathFor: (value) => value.logicalPath,
      afterOpen: async () => { entered(); await gate; },
    });
    await pending;
    client.destroy();
    release();
    await expect(running).resolves.toBeUndefined();
    expect(client.readableLength).toBe(0);
  });
});
