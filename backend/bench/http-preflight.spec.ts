import { DataSource } from "typeorm";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { FileEntity } from "../src/entities/file.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { UserEntity } from "../src/entities/user.entity";
import {
  assertSafeTargets,
  classifyStage,
  makeMultipart,
  runHttpPreflight,
  STORAGE_MARKER,
} from "./http-preflight";

const safeStorage = fs.mkdtempSync(
  path.join(os.tmpdir(), "homecloud-http-preflight-test-"),
);
fs.writeFileSync(
  path.join(safeStorage, STORAGE_MARKER),
  "YES_ISOLATED_HTTP_PREFLIGHT",
);

const safe = {
  baseUrl: "http://127.0.0.1:30123",
  databaseUrl:
    "postgres://bench:secret@127.0.0.1:55441/homecloud_http_preflight",
  storagePath: safeStorage,
  payload: Buffer.from("deterministic preflight"),
  label: "test",
  confirm: "YES_ISOLATED_HTTP_PREFLIGHT",
};

describe("HTTP preflight harness", () => {
  afterAll(() => fs.rmSync(safeStorage, { recursive: true, force: true }));

  test("не допускает штатные или неявные цели", () => {
    expect(() => assertSafeTargets({ ...safe, confirm: "" })).toThrow();
    expect(() =>
      assertSafeTargets({
        ...safe,
        databaseUrl: "postgres://bench:secret@127.0.0.1:5432/homecloud",
      }),
    ).toThrow();
    expect(() =>
      assertSafeTargets({ ...safe, storagePath: "/storage" }),
    ).toThrow();
    expect(() =>
      assertSafeTargets({ ...safe, baseUrl: "http://homebackend:3000" }),
    ).toThrow();
    const unowned = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-http-preflight-unowned-"),
    );
    expect(() =>
      assertSafeTargets({ ...safe, storagePath: unowned }),
    ).toThrow();
    fs.rmSync(unowned, { recursive: true, force: true });
  });

  test("multipart передаёт chunkIndex как строковое form field", async () => {
    const form = makeMultipart(Buffer.from("x"));
    expect(form.get("chunkIndex")).toBe("0");
    expect(form.get("chunk")).toBeInstanceOf(Blob);
  });

  test("классифицирует этапы независимо", () => {
    const result = {
      label: "x",
      sha256: "x",
      evidence: [
        { stage: "AUTH" as const, ok: true, status: 201 },
        { stage: "MULTIPART_CHUNK" as const, ok: false, status: 400 },
      ],
    };
    expect(classifyStage(result, "AUTH")).toBe("HEALTHY");
    expect(classifyStage(result, "MULTIPART_CHUNK", [400])).toBe(
      "RISK_CONFIRMED",
    );
    expect(classifyStage(result, "VERIFY")).toBe("INCONCLUSIVE");
  });

  test("ожидаемый HTTP 413 фиксируется как свидетельство, а cleanup выполняется", async () => {
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "not-logged" } }), {
        status: 201,
      }),
      new Response(JSON.stringify({ data: { uploadId: "upload-1" } }), {
        status: 201,
      }),
      new Response("request entity too large", { status: 413 }),
    ];
    const userRepo = {
      findOneByOrFail: jest.fn().mockResolvedValue({ id: 77, storageUsed: 0 }),
      delete: jest.fn().mockResolvedValue({}),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const fileRepo = {
      findBy: jest.fn().mockResolvedValue([]),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const sessionRepo = { countBy: jest.fn().mockResolvedValue(0) };
    const source = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === UserEntity) return userRepo;
        if (entity === FileEntity) return fileRepo;
        return sessionRepo;
      }),
    } as unknown as DataSource;
    const fetchImpl = jest.fn().mockImplementation(() => replies.shift());
    const result = await runHttpPreflight(
      {
        ...safe,
        fetchImpl,
      },
      source,
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "MULTIPART_CHUNK",
          ok: false,
          status: 413,
        }),
        expect.objectContaining({ stage: "CLEANUP", ok: true }),
      ]),
    );
    expect(result.evidence.find((item) => item.stage === "AUTH")?.body).toEqual(
      {
        data: { accessToken: "[REDACTED]" },
      },
    );
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe(
      "Bearer not-logged",
    );
    expect(userRepo.delete).toHaveBeenCalledWith(77);
  });

  test.each([400, 413])(
    "HTTP %s остаётся свидетельством, а не crash harness",
    async (status) => {
      const replies = [
        new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
          status: 201,
        }),
        new Response(JSON.stringify({ data: { uploadId: "upload-2" } }), {
          status: 201,
        }),
        new Response("expected failure", { status }),
      ];
      const userRepo = {
        findOneByOrFail: jest
          .fn()
          .mockResolvedValue({ id: 78, storageUsed: 0 }),
        delete: jest.fn().mockResolvedValue({}),
        countBy: jest.fn().mockResolvedValue(0),
      };
      const emptyRepo = {
        findBy: jest.fn().mockResolvedValue([]),
        countBy: jest.fn().mockResolvedValue(0),
      };
      const source = {
        getRepository: jest.fn((entity: unknown) =>
          entity === UserEntity ? userRepo : emptyRepo,
        ),
      } as unknown as DataSource;
      const result = await runHttpPreflight(
        {
          ...safe,
          fetchImpl: jest.fn().mockImplementation(() => replies.shift()),
        },
        source,
      );
      expect(
        result.evidence.find((item) => item.stage === "MULTIPART_CHUNK"),
      ).toMatchObject({
        ok: false,
        status,
      });
    },
  );

  test("успех проверяет bytes, metadata, accounting и cleanup", async () => {
    const runStorage = path.join(
      os.tmpdir(),
      `homecloud-http-preflight-success-${Date.now()}`,
    );
    fs.mkdirSync(runStorage, { recursive: true });
    fs.writeFileSync(path.join(runStorage, STORAGE_MARKER), safe.confirm);
    const finalPath = path.join(runStorage, "final.bin");
    fs.writeFileSync(finalPath, safe.payload);
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
        status: 201,
      }),
      new Response(JSON.stringify({ data: { uploadId: "upload-ok" } }), {
        status: 201,
      }),
      new Response(JSON.stringify({ data: { status: "uploading" } }), {
        status: 200,
      }),
      new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 }),
    ];
    const userRepo = {
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 79, storageUsed: 10 })
        .mockResolvedValueOnce({
          id: 79,
          storageUsed: 10 + safe.payload.length,
        }),
      delete: jest.fn().mockResolvedValue({}),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const fileRepo = {
      findBy: jest
        .fn()
        .mockResolvedValue([
          { userId: 79, size: safe.payload.length, storagePath: finalPath },
        ]),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const sessionRepo = {
      findOneBy: jest.fn().mockResolvedValue({ status: "completed" }),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const source = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === UserEntity) return userRepo;
        if (entity === FileEntity) return fileRepo;
        if (entity === UploadSessionEntity) return sessionRepo;
        throw new Error("unexpected repository");
      }),
    } as unknown as DataSource;
    const result = await runHttpPreflight(
      {
        ...safe,
        storagePath: runStorage,
        fetchImpl: jest.fn().mockImplementation(() => replies.shift()),
      },
      source,
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "VERIFY", ok: true }),
        expect.objectContaining({ stage: "CLEANUP", ok: true }),
      ]),
    );
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  test("ошибка cleanup классифицируется отдельно", async () => {
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
        status: 201,
      }),
      new Response("bad create", { status: 400 }),
    ];
    const userRepo = {
      findOneByOrFail: jest.fn().mockResolvedValue({ id: 80, storageUsed: 0 }),
      delete: jest.fn().mockRejectedValue(new Error("cleanup failed")),
      countBy: jest.fn().mockResolvedValue(0),
    };
    const source = {
      getRepository: jest.fn((entity: unknown) =>
        entity === UserEntity
          ? userRepo
          : { findBy: jest.fn().mockResolvedValue([]) },
      ),
    } as unknown as DataSource;
    const result = await runHttpPreflight(
      {
        ...safe,
        fetchImpl: jest.fn().mockImplementation(() => replies.shift()),
      },
      source,
    );
    expect(result.evidence.at(-1)).toMatchObject({
      stage: "CLEANUP",
      ok: false,
    });
  });
});
