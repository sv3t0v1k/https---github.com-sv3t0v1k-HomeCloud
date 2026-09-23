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
  computePreflightQuota,
  hasFullPreflightSuccess,
  makeMultipart,
  PreflightResult,
  runAfterFullTinySuccess,
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

  test("quota конечна, зависит от payload и защищена safe-integer проверками", () => {
    expect(computePreflightQuota(32 * 1024)).toBe(64 * 1024);
    expect(computePreflightQuota(2 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    expect(() => computePreflightQuota(0)).toThrow(/safe integer/);
    expect(() => computePreflightQuota(Number.MAX_SAFE_INTEGER)).toThrow(
      /safe integer/,
    );
  });

  test("2 MiB разрешён только после полного успеха tiny, включая cleanup", () => {
    const success = {
      label: "tiny",
      sha256: "hash",
      evidence: [
        "AUTH",
        "CREATE_SESSION",
        "MULTIPART_CHUNK",
        "COMPLETE",
        "VERIFY",
        "CLEANUP",
      ].map((stage) => ({ stage, ok: true })),
    } as PreflightResult;
    expect(hasFullPreflightSuccess(success)).toBe(true);
    expect(
      hasFullPreflightSuccess({
        ...success,
        evidence: success.evidence.map((item) =>
          item.stage === "COMPLETE" ? { ...item, ok: false } : item,
        ),
      }),
    ).toBe(false);
    expect(
      hasFullPreflightSuccess({
        ...success,
        evidence: success.evidence.map((item) =>
          item.stage === "VERIFY" ? { ...item, ok: false } : item,
        ),
      }),
    ).toBe(false);
    expect(
      hasFullPreflightSuccess({
        ...success,
        evidence: success.evidence.map((item) =>
          item.stage === "CLEANUP" ? { ...item, ok: false } : item,
        ),
      }),
    ).toBe(false);
  });

  test("runner запускает 2 MiB ровно после полного успеха tiny", async () => {
    const success: PreflightResult = {
      label: "tiny",
      sha256: "hash",
      evidence: [
        "AUTH",
        "CREATE_SESSION",
        "MULTIPART_CHUNK",
        "COMPLETE",
        "VERIFY",
        "CLEANUP",
      ].map((stage) => ({ stage, ok: true })) as PreflightResult["evidence"],
    };
    const large = jest.fn().mockResolvedValue({
      label: "large",
      sha256: "large-hash",
      evidence: [],
    });
    await expect(
      runAfterFullTinySuccess(success, large),
    ).resolves.toMatchObject({
      label: "large",
    });
    expect(large).toHaveBeenCalledTimes(1);

    for (const failedStage of ["COMPLETE", "VERIFY"] as const) {
      large.mockClear();
      const failed = {
        ...success,
        evidence: success.evidence.map((item) =>
          item.stage === failedStage ? { ...item, ok: false } : item,
        ),
      };
      await expect(
        runAfterFullTinySuccess(failed, large),
      ).resolves.toBeUndefined();
      expect(large).not.toHaveBeenCalled();
    }
  });

  test("останавливается, если quota после записи не подтверждена перезагрузкой", async () => {
    const userRepo = {
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 81, storageUsed: 0, storageQuota: 0 })
        .mockResolvedValueOnce({ id: 81, storageUsed: 0, storageQuota: "0" }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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

    await expect(
      runHttpPreflight(
        {
          ...safe,
          fetchImpl: jest
            .fn()
            .mockResolvedValue(
              new Response(
                JSON.stringify({ data: { accessToken: "secret" } }),
                { status: 201 },
              ),
            ),
        },
        source,
      ),
    ).rejects.toThrow(/Quota после перезагрузки не совпала/);
    expect(userRepo.update).toHaveBeenCalledWith(81, {
      storageQuota: computePreflightQuota(safe.payload.length),
    });
    expect(userRepo.delete).toHaveBeenCalledWith(81);
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
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 77, storageUsed: 0, storageQuota: 0 })
        .mockResolvedValueOnce({
          id: 77,
          storageUsed: 0,
          storageQuota: computePreflightQuota(safe.payload.length),
        }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
          .mockResolvedValueOnce({ id: 78, storageUsed: 0, storageQuota: 0 })
          .mockResolvedValueOnce({
            id: 78,
            storageUsed: 0,
            storageQuota: computePreflightQuota(safe.payload.length),
          }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    const finalPath = path.join(runStorage, "79", "final.bin");
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
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
        .mockResolvedValueOnce({ id: 79, storageUsed: 10, storageQuota: 0 })
        .mockResolvedValueOnce({
          id: 79,
          storageUsed: 10,
          storageQuota: computePreflightQuota(safe.payload.length),
        })
        .mockResolvedValueOnce({
          id: 79,
          storageUsed: 10 + safe.payload.length,
          storageQuota: computePreflightQuota(safe.payload.length),
        }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
      findOneBy: jest
        .fn()
        .mockResolvedValue({ uploadId: "upload-ok", status: "completed" }),
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
    expect(userRepo.update).toHaveBeenCalledWith(79, {
      storageQuota: computePreflightQuota(safe.payload.length),
    });
    expect(
      result.evidence.find((item) => item.stage === "VERIFY")?.body,
    ).toMatchObject({
      expectedSha256: result.sha256,
      actualSha256: result.sha256,
      size: safe.payload.length,
      fileRows: 1,
      sessionStatus: "completed",
      storageUsedDelta: safe.payload.length,
      storageQuota: computePreflightQuota(safe.payload.length),
    });
  });

  test("ошибка cleanup классифицируется отдельно", async () => {
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
        status: 201,
      }),
      new Response("bad create", { status: 400 }),
    ];
    const userRepo = {
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 80, storageUsed: 0, storageQuota: 0 })
        .mockResolvedValueOnce({
          id: 80,
          storageUsed: 0,
          storageQuota: computePreflightQuota(safe.payload.length),
        }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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

  test("cleanup не удаляет путь из DB вне owned storage", async () => {
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-http-preflight-external-"),
    );
    const externalFile = path.join(externalDir, "must-survive.bin");
    fs.writeFileSync(externalFile, "must survive");
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
        status: 201,
      }),
      new Response("bad create", { status: 400 }),
    ];
    const userRepo = {
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 82, storageUsed: 0, storageQuota: 0 })
        .mockResolvedValueOnce({
          id: 82,
          storageUsed: 0,
          storageQuota: computePreflightQuota(safe.payload.length),
        }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({}),
      countBy: jest.fn().mockResolvedValue(1),
    };
    const fileRepo = {
      findBy: jest.fn().mockResolvedValue([{ storagePath: externalFile }]),
      countBy: jest.fn().mockResolvedValue(1),
    };
    const source = {
      getRepository: jest.fn((entity: unknown) =>
        entity === UserEntity ? userRepo : fileRepo,
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
    expect(fs.readFileSync(externalFile, "utf8")).toBe("must survive");
    expect(userRepo.delete).not.toHaveBeenCalled();
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  test("cleanup отклоняет symlink user root и сохраняет внешний файл", async () => {
    const runStorage = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-http-preflight-symlink-"),
    );
    fs.writeFileSync(path.join(runStorage, STORAGE_MARKER), safe.confirm);
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-http-preflight-symlink-target-"),
    );
    const externalFile = path.join(externalDir, "must-survive.bin");
    fs.writeFileSync(externalFile, "must survive symlink");
    fs.symlinkSync(externalDir, path.join(runStorage, "83"), "dir");
    const linkedFile = path.join(runStorage, "83", "must-survive.bin");
    const replies = [
      new Response(JSON.stringify({ data: { accessToken: "secret" } }), {
        status: 201,
      }),
      new Response("bad create", { status: 400 }),
    ];
    const userRepo = {
      findOneByOrFail: jest
        .fn()
        .mockResolvedValueOnce({ id: 83, storageUsed: 0, storageQuota: 0 })
        .mockResolvedValueOnce({
          id: 83,
          storageUsed: 0,
          storageQuota: computePreflightQuota(safe.payload.length),
        }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({}),
      countBy: jest.fn().mockResolvedValue(1),
    };
    const fileRepo = {
      findBy: jest.fn().mockResolvedValue([{ storagePath: linkedFile }]),
      countBy: jest.fn().mockResolvedValue(1),
    };
    const source = {
      getRepository: jest.fn((entity: unknown) =>
        entity === UserEntity ? userRepo : fileRepo,
      ),
    } as unknown as DataSource;

    const result = await runHttpPreflight(
      {
        ...safe,
        storagePath: runStorage,
        fetchImpl: jest.fn().mockImplementation(() => replies.shift()),
      },
      source,
    );
    expect(result.evidence.at(-1)).toMatchObject({
      stage: "CLEANUP",
      ok: false,
    });
    expect(fs.readFileSync(externalFile, "utf8")).toBe("must survive symlink");
    expect(userRepo.delete).not.toHaveBeenCalled();
    fs.rmSync(runStorage, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  });
});
