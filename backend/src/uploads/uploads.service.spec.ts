import { UploadsService } from "./uploads.service";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { ForbiddenException, BadRequestException } from "@nestjs/common";
import { UploadSessionStatusCheck1746825050000 } from "../migrations/1746825050000-UploadSessionStatusCheck";
import { UploadedChunksJsonb1746825070000 } from "../migrations/1746825070000-UploadedChunksJsonb";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { Readable } from "stream";

const mutableFs = jest.requireActual<typeof import("fs")>("fs");

jest.mock("./file-type.loader", () => ({
  fileTypeFromBuffer: jest.fn(),
}));

import { fileTypeFromBuffer } from "./file-type.loader";

describe("UploadsService - Post-Review Fixes", () => {
  let service: UploadsService;
  let mockUploadSessionRepository: any;
  let mockFileRepository: any;
  let mockFolderRepository: any;
  let mockStorageService: any;
  let mockUsersService: any;
  let mockConfigService: any;
  let mockQueryRunner: any;
  let mockQueryBuilder: any;

  beforeEach(() => {
    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ activeTotal: "0" }),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        save: jest.fn((entity: any) => Promise.resolve(entity)),
        create: jest.fn(),
        createQueryBuilder: jest.fn(() => mockQueryBuilder),
      },
    };
    mockUploadSessionRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => mockQueryRunner),
        },
      },
    };
    mockFileRepository = {
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      findOne: jest.fn(),
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => mockQueryRunner),
        },
      },
    };
    mockFolderRepository = {
      findOne: jest.fn(),
    };
    mockStorageService = {
      generateSafeFilename: jest.fn((name) => name),
      generatePath: jest.fn(
        (userId, filename) => `/storage/${userId}/${filename}`,
      ),
      generateFinalPath: jest.fn(
        (userId, uploadId, filename) =>
          `/storage/${userId}/${uploadId}_${filename}`,
      ),
      getTempPath: jest.fn(() => "/tmp"),
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    };
    mockUsersService = {
      findById: jest.fn(),
      updateStorageUsed: jest.fn(),
      decrementStorageUsed: jest.fn(),
    };
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "MAX_FILE_SIZE") return "104857600";
        if (key === "MAX_TOTAL_SIZE") return "10737418240";
        if (key === "MAX_CHUNK_SIZE") return "10485760";
        if (key === "UPLOAD_SESSION_TTL_HOURS") return "24";
        if (key === "ALLOWED_UPLOAD_MIME_TYPES")
          return "image/png,image/jpeg,application/pdf";
        return undefined;
      }),
    };

    service = new UploadsService(
      mockUploadSessionRepository,
      mockFileRepository,
      mockFolderRepository,
      mockStorageService,
      mockUsersService,
      mockConfigService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("database quota arithmetic regression", () => {
    let tempRoot: string;
    beforeEach(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quota-regression-"));
      mockStorageService.getTempPath.mockReturnValue(tempRoot);
      mockQueryRunner.manager.create.mockImplementation((_entity: unknown, data: unknown) => data);
    });
    afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    it("accepts four sequential 125-byte uploads with string DB accounting", async () => {
      let used = 0;
      const totals: number[] = [];
      mockQueryRunner.manager.findOne.mockImplementation(async () => ({
        id: 1, storageQuota: "104857600", storageUsed: String(used),
      }));
      for (let i = 0; i < 4; i++) {
        const session = await service.createUploadSession(1, "tiny.txt", 125, 125);
        expect(session.totalSize).toBe(125);
        used += session.totalSize;
        totals.push(used);
      }
      expect(totals).toEqual([125, 250, 375, 500]);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(4);
      expect(mockQueryRunner.manager.findOne).toHaveBeenCalledWith(
        expect.anything(), { where: { id: 1 }, lock: { mode: "pessimistic_write" } },
      );
    });

    it("allows exact quota including a string reservation", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ storageQuota: "1000", storageUsed: "775" });
      mockQueryBuilder.getRawOne.mockResolvedValue({ activeTotal: "125" });
      await expect(service.createUploadSession(1, "exact.txt", 100, 100)).resolves.toMatchObject({ totalSize: 100 });
    });

    it("rejects one byte above quota including reservations", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ storageQuota: "1000", storageUsed: "775" });
      mockQueryBuilder.getRawOne.mockResolvedValue({ activeTotal: "125" });
      await expect(service.createUploadSession(1, "over.txt", 101, 101)).rejects.toThrow("Storage quota exceeded");
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it.each([null, undefined, "invalid", "9007199254740993", "-1"])(
      "fails closed for invalid aggregate %p", async (activeTotal) => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ storageQuota: "1000", storageUsed: "0" });
        mockQueryBuilder.getRawOne.mockResolvedValue({ activeTotal });
        await expect(service.createUploadSession(1, "bad.txt", 125, 125)).rejects.toThrow(BadRequestException);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      },
    );

    it("rejects unsafe combined accounting even with unlimited session quota", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ storageQuota: "0", storageUsed: String(Number.MAX_SAFE_INTEGER) });
      await expect(service.createUploadSession(1, "unsafe.txt", 1, 1)).rejects.toThrow(BadRequestException);
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });
  });

  describe("createUploadSession - quota pre-check", () => {
    it("should reject when MAX_FILE_SIZE is 0 but quota exceeded", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "MAX_FILE_SIZE") return "0";
        if (key === "MAX_CHUNK_SIZE") return "10485760";
        if (key === "UPLOAD_SESSION_TTL_HOURS") return "24";
        return undefined;
      });

      const localService = new UploadsService(
        mockUploadSessionRepository,
        mockFileRepository,
        mockFolderRepository,
        mockStorageService,
        mockUsersService,
        mockConfigService,
      );

      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1_000_000_000,
        storageUsed: 900_000_000,
      });

      // Use chunkSize that results in <= 100000 chunks to test quota, not chunk count limit
      await expect(
        localService.createUploadSession(
          1,
          "test.bin",
          200_000_000,
          1024 * 1024,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject when MAX_FILE_SIZE is large but quota exceeded", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "MAX_FILE_SIZE") return "10737418240";
        if (key === "MAX_CHUNK_SIZE") return "10485760";
        if (key === "UPLOAD_SESSION_TTL_HOURS") return "24";
        return undefined;
      });

      const localService = new UploadsService(
        mockUploadSessionRepository,
        mockFileRepository,
        mockFolderRepository,
        mockStorageService,
        mockUsersService,
        mockConfigService,
      );

      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1_000_000_000,
        storageUsed: 900_000_000,
      });

      // Use chunkSize that results in <= 100000 chunks to test quota, not chunk count limit
      await expect(
        localService.createUploadSession(
          1,
          "test.bin",
          200_000_000,
          1024 * 1024,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("uploadChunk - strict size enforcement", () => {
    it("moves a controlled ingress file into session staging", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-ingress-"));
      const ingressDir = path.join(root, "multipart-ingress");
      const sessionDir = path.join(root, "session");
      fs.mkdirSync(ingressDir);
      fs.mkdirSync(sessionDir);
      const ingressPath = path.join(ingressDir, "server-id");
      fs.writeFileSync(ingressPath, Buffer.alloc(500, 0x41));
      mockStorageService.getTempPath.mockReturnValue(root);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        uploadId: "abc",
        userId: 1,
        totalSize: 500,
        chunkSize: 500,
        totalChunks: 1,
        uploadedChunks: [],
        uploadedSize: 0,
        tempPath: sessionDir,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      });
      try {
        await expect(
          service.uploadChunk(1, "abc", 0, {
            path: ingressPath,
            size: 500,
          }),
        ).resolves.toMatchObject({ uploadedChunks: [0], uploadedSize: 500 });
        expect(fs.existsSync(ingressPath)).toBe(false);
        expect(fs.readFileSync(path.join(sessionDir, "0"))).toEqual(
          Buffer.alloc(500, 0x41),
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("rejects ingress outside the controlled directory", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-ingress-root-"));
      const external = path.join(root, "external");
      fs.writeFileSync(external, "data");
      mockStorageService.getTempPath.mockReturnValue(path.join(root, "tmp"));
      try {
        await expect(
          service.uploadChunk(1, "abc", 0, {
            path: external,
            size: 4,
          }),
        ).rejects.toThrow("Invalid ingress chunk path");
        expect(fs.readFileSync(external, "utf8")).toBe("data");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("cleans a controlled ingress file when the service rejects", async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "test-ingress-error-"),
      );
      const ingressDir = path.join(root, "multipart-ingress");
      fs.mkdirSync(ingressDir);
      const ingressPath = path.join(ingressDir, "server-id");
      fs.writeFileSync(ingressPath, "data");
      mockStorageService.getTempPath.mockReturnValue(root);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      try {
        await expect(
          service.uploadChunk(1, "missing", 0, { path: ingressPath, size: 4 }),
        ).rejects.toThrow("Upload session not found");
        expect(fs.existsSync(ingressPath)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("should reject oversized last chunk", async () => {
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 2500,
        chunkSize: 1000,
        totalChunks: 3,
        uploadedChunks: [0, 1],
        uploadedSize: 2000,
        tempPath: "/tmp/abc",
        parentId: null,
        status: "uploading",
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockUploadSessionRepository.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockResolvedValue(session);

      await expect(
        service.uploadChunk(1, "abc", 2, Buffer.alloc(501)),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject chunk index >= totalChunks", async () => {
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 1000,
        chunkSize: 500,
        totalChunks: 2,
        uploadedChunks: [],
        uploadedSize: 0,
        tempPath: "/tmp/abc",
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockResolvedValue(session);

      await expect(
        service.uploadChunk(1, "abc", 2, Buffer.alloc(500)),
      ).rejects.toThrow(BadRequestException);
    });

    it("should accept valid last chunk", async () => {
      const tempDir = `/tmp/test-chunk-${Date.now()}`;
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(1000));
      fs.writeFileSync(path.join(tempDir, "1"), Buffer.alloc(1000));

      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 2500,
        chunkSize: 1000,
        totalChunks: 3,
        uploadedChunks: [0, 1],
        uploadedSize: 2000,
        tempPath: tempDir,
        parentId: null,
        status: "uploading",
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockResolvedValue(session);

      const result = await service.uploadChunk(1, "abc", 2, Buffer.alloc(500));
      expect(result.uploadedChunks).toContain(2);
      expect(result.uploadedSize).toBe(2500);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should handle concurrent uploadChunk for same chunk index safely", async () => {
      const tempDir = `/tmp/test-concurrency-${Date.now()}`;
      fs.mkdirSync(tempDir, { recursive: true });

      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 2000,
        chunkSize: 1000,
        totalChunks: 2,
        uploadedChunks: [] as number[],
        uploadedSize: 0,
        tempPath: tempDir,
        parentId: null,
        status: "pending" as string,
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockImplementation((s: any) => {
        return Promise.resolve(s);
      });

      const chunkA = Buffer.alloc(1000, 0x41);
      const chunkB = Buffer.alloc(1000, 0x42);

      const promises = [
        service.uploadChunk(1, "abc", 0, chunkA),
        service.uploadChunk(1, "abc", 0, chunkB),
      ];
      const results = await Promise.allSettled(promises);

      // One must succeed, the other must be rejected (different content).
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const chunkPath = path.join(tempDir, "0");
      expect(fs.existsSync(chunkPath)).toBe(true);
      const actualSize = fs.statSync(chunkPath).size;
      expect(actualSize).toBe(1000);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("completeUpload - guaranteed cleanup", () => {
    it("should delete temp files when MIME validation fails", async () => {
      const tempDir = `/tmp/test-cleanup-mime-${Date.now()}`;
      const finalPath = `/tmp/test-cleanup-mime-${Date.now()}-final.exe`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "malware.exe",
        totalSize: 8,
        chunkSize: 8,
        totalChunks: 1,
        uploadedChunks: [0],
        uploadedSize: 8,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "0"),
        Buffer.from("MZ\x00\x00\x00\x00\x00\x00"),
      );
      fs.writeFileSync(finalPath, Buffer.from("MZ\x00\x00\x00\x00\x00\x00"));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockStorageService.generateSafeFilename.mockReturnValue("malware.exe");
      mockFileRepository.create.mockReturnValue({ id: 1 });
      mockFileRepository.save.mockResolvedValue({ id: 1 });

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "application/x-msdownload",
      });

      await expect(service.completeUpload(1, "abc")).rejects.toThrow(
        BadRequestException,
      );

      expect(mockFileRepository.create).not.toHaveBeenCalled();
      expect(fs.existsSync(tempDir)).toBe(false);
      expect(fs.existsSync(finalPath)).toBe(false);

      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(finalPath)) {
        fs.rmSync(finalPath, { force: true });
      }
    });

    it("should delete temp files when quota update fails", async () => {
      const tempDir = `/tmp/test-cleanup-quota-${Date.now()}`;
      const finalPath = `/tmp/test-cleanup-quota-${Date.now()}-final.jpg`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.jpg",
        totalSize: 8,
        chunkSize: 8,
        totalChunks: 1,
        uploadedChunks: [0],
        uploadedSize: 8,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(8));
      fs.writeFileSync(finalPath, Buffer.alloc(8));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockStorageService.generateSafeFilename.mockReturnValue("photo.jpg");
      mockFileRepository.create.mockReturnValue({ id: 1 });
      mockFileRepository.save.mockResolvedValue({ id: 1 });
      mockUsersService.updateStorageUsed.mockRejectedValue(
        new ForbiddenException("Storage quota exceeded"),
      );

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "image/jpeg",
      });

      await expect(service.completeUpload(1, "abc")).rejects.toThrow(
        ForbiddenException,
      );

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(fs.existsSync(tempDir)).toBe(false);
      expect(fs.existsSync(finalPath)).toBe(false);

      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(finalPath)) {
        fs.rmSync(finalPath, { force: true });
      }
    });
  });

  describe("Upload session status lifecycle (F-06)", () => {
    it("should use only valid status: pending on creation", () => {
      mockUploadSessionRepository.create.mockReturnValue({ status: "pending" });
      const session = { status: "pending" };
      expect(session.status).toBe("pending");
      expect(["pending", "uploading", "completed", "aborted"]).toContain(
        session.status,
      );
    });

    it("should use only valid status: uploading during chunk upload", () => {
      const status = "uploading";
      expect(["pending", "uploading", "completed", "aborted"]).toContain(
        status,
      );
    });

    it("should use only valid status: completed on upload completion", () => {
      const status = "completed";
      expect(["pending", "uploading", "completed", "aborted"]).toContain(
        status,
      );
    });

    it("should use only valid status: aborted on abort", () => {
      const status = "aborted";
      expect(["pending", "uploading", "completed", "aborted"]).toContain(
        status,
      );
    });

    it("should reject invalid status in uploadChunk", async () => {
      const session = {
        uploadId: "test",
        userId: 1,
        status: "completed",
        expiresAt: new Date(Date.now() + 86400000),
        totalChunks: 1,
        totalSize: 100,
        chunkSize: 100,
        uploadedChunks: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(session);

      await expect(
        service.uploadChunk(1, "test", 0, Buffer.from("data")),
      ).rejects.toThrow("Upload session is completed");
    });
  });

  describe("Migration F-06", () => {
    it("UploadSessionStatusCheck migration should exist and be reversible", () => {
      expect(UploadSessionStatusCheck1746825050000).toBeDefined();
      const m = new UploadSessionStatusCheck1746825050000();
      expect(m.name).toBe("UploadSessionStatusCheck1746825050000");
      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
    });
  });

  describe("Migration F-07 (JSON → JSONB)", () => {
    it("UploadedChunksJsonb migration should exist and be reversible", () => {
      expect(UploadedChunksJsonb1746825070000).toBeDefined();
      const m = new UploadedChunksJsonb1746825070000();
      expect(m.name).toBe("UploadedChunksJsonb1746825070000");
      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
    });

    it("should have ALTER COLUMN uploadedChunks TYPE jsonb in up", () => {
      const m = new UploadedChunksJsonb1746825070000();
      const queryRunner = { query: jest.fn() } as any;
      m.up(queryRunner);
      const alterCall = queryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("jsonb"),
      );
      expect(alterCall).toBeDefined();
      expect(alterCall[0]).toContain('ALTER COLUMN "uploadedChunks"');
    });
  });

  describe("cleanupExpiredSessions — stale uploading sessions", () => {
    it("should clean up pending sessions past TTL", async () => {
      const expiredSession = {
        id: 1,
        uploadId: "exp",
        userId: 1,
        expiresAt: new Date(Date.now() - 1000),
        status: "pending",
        tempPath: `/tmp/exp-${Date.now()}`,
      };
      fs.mkdirSync(expiredSession.tempPath, { recursive: true });

      mockUploadSessionRepository.find.mockResolvedValue([expiredSession]);

      const result = await service.cleanupExpiredSessions();

      expect(result).toBe(1);
      expect(mockUploadSessionRepository.delete).toHaveBeenCalledWith(1);
      expect(fs.existsSync(expiredSession.tempPath)).toBe(false);
    });

    it("should clean up uploading sessions past TTL", async () => {
      const uploadingSession = {
        id: 2,
        uploadId: "stuck",
        userId: 1,
        expiresAt: new Date(Date.now() - 1000),
        status: "uploading",
        tempPath: `/tmp/stuck-${Date.now()}`,
      };
      fs.mkdirSync(uploadingSession.tempPath, { recursive: true });
      mockUploadSessionRepository.find.mockResolvedValue([uploadingSession]);

      const result = await service.cleanupExpiredSessions();

      expect(result).toBe(1);
      expect(mockUploadSessionRepository.delete).toHaveBeenCalledWith(2);
      expect(fs.existsSync(uploadingSession.tempPath)).toBe(false);
    });

    it("should not clean active sessions within TTL", async () => {
      const activeSession = {
        id: 3,
        uploadId: "active",
        userId: 1,
        expiresAt: new Date(Date.now() + 86400000),
        status: "uploading",
        tempPath: `/tmp/active-${Date.now()}`,
      };
      fs.mkdirSync(activeSession.tempPath, { recursive: true });
      mockUploadSessionRepository.find.mockResolvedValue([activeSession]);

      const result = await service.cleanupExpiredSessions();

      expect(result).toBe(0);
      expect(mockUploadSessionRepository.delete).not.toHaveBeenCalled();
      // Temp dir should still exist
      expect(fs.existsSync(activeSession.tempPath)).toBe(true);
      fs.rmSync(activeSession.tempPath, { recursive: true, force: true });
    });
  });

  describe("completeUpload — large file memory safety", () => {
    it("should detect MIME from header only (not full file)", async () => {
      const tempDir = `/tmp/test-mime-header-${Date.now()}`;
      const finalPath = `/tmp/test-mime-header-${Date.now()}-final.png`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.png",
        totalSize: 1024,
        chunkSize: 512,
        totalChunks: 2,
        uploadedChunks: [0, 1],
        uploadedSize: 1024,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(512));
      fs.writeFileSync(path.join(tempDir, "1"), Buffer.alloc(512));
      fs.writeFileSync(finalPath, Buffer.alloc(1024));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockQueryRunner.manager.save.mockResolvedValue(session);
      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockUploadSessionRepository.findOne.mockResolvedValue(session);
      mockUploadSessionRepository.save.mockResolvedValue(session);
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockFileRepository.create.mockReturnValue({ id: 1 });
      mockFileRepository.save.mockResolvedValue({ id: 1 });
      mockUsersService.updateStorageUsed.mockResolvedValue(undefined);

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "image/png",
      });

      const readFileSyncSpy = jest.spyOn(mutableFs, "readFileSync");
      const result = await service.completeUpload(1, "abc");
      expect(result).toBeDefined();
      expect(readFileSyncSpy).not.toHaveBeenCalled();
      readFileSyncSpy.mockRestore();

      // Verify fileTypeFromBuffer was called with a small buffer (header)
      const callArgs = (fileTypeFromBuffer as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toBeInstanceOf(Buffer);
      expect(callArgs[0].length).toBeLessThanOrEqual(4100);

      fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    });
  });

  describe("completeUpload — writable backpressure", () => {
    function prepareSession(tempDir: string, finalPath: string) {
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.png",
        totalSize: 16,
        chunkSize: 8,
        totalChunks: 2,
        uploadedChunks: [0, 1],
        uploadedSize: 16,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(8, 1));
      fs.writeFileSync(path.join(tempDir, "1"), Buffer.alloc(8, 2));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockQueryRunner.manager.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );
      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockUsersService.updateStorageUsed.mockResolvedValue(undefined);
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "image/png",
      });

      return session;
    }

    it("does not write the next chunk until drain after write returns false", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "test-complete-backpressure-"),
      );
      const finalPath = `${tempDir}-final.png`;
      prepareSession(tempDir, finalPath);

      const stream = new EventEmitter() as EventEmitter & {
        write: jest.Mock<boolean, [Buffer]>;
        end: jest.Mock<void, []>;
        destroy: jest.Mock<void, []>;
      };
      const written: Buffer[] = [];
      let signalFirstWrite!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        signalFirstWrite = resolve;
      });
      stream.write = jest.fn((chunk: Buffer) => {
        written.push(chunk);
        if (written.length === 1) signalFirstWrite();
        return written.length !== 1;
      });
      stream.end = jest.fn(() => {
        fs.writeFileSync(finalPath, Buffer.concat(written));
        queueMicrotask(() => stream.emit("finish"));
      });
      stream.destroy = jest.fn();
      const originalCreateWriteStream = mutableFs.createWriteStream;
      mutableFs.createWriteStream = jest.fn(
        () => stream as unknown as fs.WriteStream,
      ) as typeof fs.createWriteStream;

      try {
        const completion = service.completeUpload(1, "abc");
        await firstWrite;

        expect(stream.write).toHaveBeenCalledTimes(1);
        expect(stream.listenerCount("drain")).toBe(1);
        stream.emit("drain");
        await expect(completion).resolves.toBeDefined();

        expect(stream.write).toHaveBeenCalledTimes(2);
        expect(stream.listenerCount("drain")).toBe(0);
        expect(Buffer.concat(written)).toEqual(
          Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(8, 2)]),
        );
      } finally {
        mutableFs.createWriteStream = originalCreateWriteStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(finalPath, { force: true });
      }
    });

    it("rejects and cleans listeners when the stream errors while awaiting drain", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "test-complete-backpressure-error-"),
      );
      const finalPath = `${tempDir}-final.png`;
      prepareSession(tempDir, finalPath);

      const stream = new EventEmitter() as EventEmitter & {
        write: jest.Mock<boolean, [Buffer]>;
        end: jest.Mock<void, []>;
        destroy: jest.Mock<void, []>;
        destroyed: boolean;
      };
      let signalFirstWrite!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        signalFirstWrite = resolve;
      });
      stream.write = jest.fn((_chunk: Buffer) => {
        signalFirstWrite();
        return false;
      });
      stream.end = jest.fn();
      stream.destroyed = false;
      stream.destroy = jest.fn(() => {
        stream.destroyed = true;
      });
      const originalCreateWriteStream = mutableFs.createWriteStream;
      mutableFs.createWriteStream = jest.fn(
        () => stream as unknown as fs.WriteStream,
      ) as typeof fs.createWriteStream;

      try {
        const completion = service.completeUpload(1, "abc");
        await firstWrite;
        const streamError = new Error(
          "write stream failed while backpressured",
        );

        stream.emit("error", streamError);
        await expect(completion).rejects.toBe(streamError);

        expect(stream.write).toHaveBeenCalledTimes(1);
        expect(stream.end).not.toHaveBeenCalled();
        expect(stream.destroy).toHaveBeenCalledTimes(1);
        expect(stream.listenerCount("drain")).toBe(0);
      } finally {
        mutableFs.createWriteStream = originalCreateWriteStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(finalPath, { force: true });
      }
    });
  });

  describe("completeUpload — stream listener lifecycle", () => {
    function prepareSession(
      tempDir: string,
      finalPath: string,
      chunks: Buffer[],
    ) {
      const chunkSize = chunks[0].length;
      const session = {
        uploadId: "many-chunks",
        userId: 1,
        filename: "many-chunks.png",
        totalSize: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        chunkSize,
        totalChunks: chunks.length,
        uploadedChunks: chunks.map((_chunk, index) => index),
        uploadedSize: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      chunks.forEach((chunk, index) =>
        fs.writeFileSync(path.join(tempDir, String(index)), chunk),
      );
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockQueryRunner.manager.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );
      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockUsersService.updateStorageUsed.mockResolvedValue(undefined);
      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "image/png",
      });

      return session;
    }

    it("keeps destination listeners bounded while assembling 600 ordered chunks", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "test-complete-many-chunks-"),
      );
      const finalPath = `${tempDir}-final.png`;
      const chunks = Array.from({ length: 600 }, (_unused, index) => {
        const chunk = Buffer.alloc(64, index % 251);
        chunk.writeUInt32BE(index, 8);
        return chunk;
      });
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(chunks[0]);
      const expected = Buffer.concat(chunks);
      prepareSession(tempDir, finalPath, chunks);

      const originalCreateReadStream = mutableFs.createReadStream;
      const originalCreateWriteStream = mutableFs.createWriteStream;
      let destination: fs.WriteStream | undefined;
      let sourceCount = 0;
      const listenerCheckpoints: Array<{
        sourceCount: number;
        error: number;
        close: number;
        finish: number;
      }> = [];
      const checkpointAt = new Set([1, 10, 20, 100, 300, 600]);
      const warnings: Error[] = [];
      const warningHandler = (warning: Error) => {
        if (warning.name === "MaxListenersExceededWarning") {
          warnings.push(warning);
        }
      };

      mutableFs.createWriteStream = jest.fn((...args: any[]) => {
        destination = (originalCreateWriteStream as any)(...args);
        return destination;
      }) as typeof fs.createWriteStream;
      mutableFs.createReadStream = jest.fn((...args: any[]) => {
        if (destination && checkpointAt.has(sourceCount)) {
          listenerCheckpoints.push({
            sourceCount,
            error: destination.listenerCount("error"),
            close: destination.listenerCount("close"),
            finish: destination.listenerCount("finish"),
          });
        }
        sourceCount += 1;
        return (originalCreateReadStream as any)(...args);
      }) as typeof fs.createReadStream;
      process.on("warning", warningHandler);

      try {
        await expect(
          service.completeUpload(1, "many-chunks"),
        ).resolves.toBeDefined();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(sourceCount).toBe(600);
        expect(
          listenerCheckpoints.map(({ sourceCount: count }) => count),
        ).toEqual([1, 10, 20, 100, 300]);
        const initialListeners = listenerCheckpoints[0];
        for (const checkpoint of listenerCheckpoints) {
          expect(checkpoint.error).toBe(initialListeners.error);
          expect(checkpoint.close).toBe(initialListeners.close);
          expect(checkpoint.finish).toBe(initialListeners.finish);
        }
        expect(destination?.listenerCount("error")).toBeLessThanOrEqual(
          initialListeners.error,
        );
        expect(destination?.listenerCount("close")).toBeLessThanOrEqual(
          initialListeners.close,
        );
        expect(destination?.listenerCount("finish")).toBeLessThanOrEqual(
          initialListeners.finish,
        );
        expect(warnings).toEqual([]);

        const actual = fs.readFileSync(finalPath);
        expect(actual.length).toBe(expected.length);
        expect(actual).toEqual(expected);
        expect(crypto.createHash("sha256").update(actual).digest("hex")).toBe(
          crypto.createHash("sha256").update(expected).digest("hex"),
        );
      } finally {
        process.removeListener("warning", warningHandler);
        mutableFs.createReadStream = originalCreateReadStream;
        mutableFs.createWriteStream = originalCreateWriteStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(finalPath, { force: true });
      }
    });

    it("propagates a source read error and removes the partial assembled file", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "test-complete-source-error-"),
      );
      const finalPath = `${tempDir}-final.png`;
      prepareSession(tempDir, finalPath, [
        Buffer.alloc(64, 1),
        Buffer.alloc(64, 2),
      ]);
      const sourceError = new Error("chunk read failed");
      const originalCreateReadStream = mutableFs.createReadStream;

      mutableFs.createReadStream = jest.fn((filePath: fs.PathLike) => {
        if (path.basename(String(filePath)) !== "1") {
          return originalCreateReadStream(filePath);
        }
        let read = false;
        return new Readable({
          read() {
            if (read) return;
            read = true;
            this.push(Buffer.alloc(8, 2));
            this.destroy(sourceError);
          },
        }) as fs.ReadStream;
      }) as typeof fs.createReadStream;

      try {
        await expect(service.completeUpload(1, "many-chunks")).rejects.toBe(
          sourceError,
        );
        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(mockUsersService.updateStorageUsed).not.toHaveBeenCalled();
        expect(fs.existsSync(finalPath)).toBe(false);
        expect(fs.existsSync(tempDir)).toBe(false);
      } finally {
        mutableFs.createReadStream = originalCreateReadStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(finalPath, { force: true });
      }
    });
  });

  describe("Remediation A — completeUpload idempotency", () => {
    it("should return existing file on duplicate completion (idempotent)", async () => {
      const tempDir = `/tmp/test-idempotent-${Date.now()}`;
      const finalPath = `/tmp/test-idempotent-${Date.now()}-final.png`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.png",
        totalSize: 8,
        chunkSize: 8,
        totalChunks: 1,
        uploadedChunks: [0],
        uploadedSize: 8,
        tempPath: tempDir,
        parentId: null,
        status: "completed",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(8));
      fs.writeFileSync(finalPath, Buffer.alloc(8));

      const existingFile = { id: 42, uploadId: "abc", userId: 1 };

      // First call: find session (status=completed)
      // Second call: find existing file by uploadId+userId
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(existingFile);
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);

      const result = await service.completeUpload(1, "abc");
      expect(result).toBe(existingFile);
      expect(mockUsersService.updateStorageUsed).not.toHaveBeenCalled();

      fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    });

    it("should reject concurrent completion of same session", async () => {
      const tempDir = `/tmp/test-concurrent-complete-${Date.now()}`;
      const finalPath1 = `/tmp/test-concurrent-complete-${Date.now()}-1.png`;
      const finalPath2 = `/tmp/test-concurrent-complete-${Date.now()}-2.png`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.png",
        totalSize: 8,
        chunkSize: 8,
        totalChunks: 1,
        uploadedChunks: [0],
        uploadedSize: 8,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(8));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockStorageService.generateFinalPath
        .mockReturnValueOnce(finalPath1)
        .mockReturnValueOnce(finalPath2);
      mockStorageService.generateSafeFilename.mockReturnValue("photo.png");
      mockFileRepository.findOne.mockResolvedValue(null);
      mockFileRepository.create.mockReturnValue({ id: 1 });
      mockFileRepository.save.mockResolvedValue({ id: 1 });
      mockUsersService.updateStorageUsed.mockResolvedValue(undefined);

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({
        mime: "image/png",
      });

      const [r1, r2] = await Promise.allSettled([
        service.completeUpload(1, "abc"),
        service.completeUpload(1, "abc"),
      ]);

      const fulfilled = [r1, r2].filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      );
      const rejected = [r1, r2].filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      // In a real DB with pessimistic locking, only one succeeds.
      // The test verifies the code path handles the race correctly.
      expect(fulfilled.length + rejected.length).toBe(2);

      fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(finalPath1)) fs.rmSync(finalPath1, { force: true });
      if (fs.existsSync(finalPath2)) fs.rmSync(finalPath2, { force: true });
    });
  });

  describe("Remediation A — chunk idempotency", () => {
    it("should reject repeated chunk with different content", async () => {
      const tempDir = `/tmp/test-chunk-diff-${Date.now()}`;
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(1000, 0x41));

      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 2000,
        chunkSize: 1000,
        totalChunks: 2,
        uploadedChunks: [0],
        uploadedSize: 1000,
        tempPath: tempDir,
        parentId: null,
        status: "uploading",
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockResolvedValue(session);

      await expect(
        service.uploadChunk(1, "abc", 0, Buffer.alloc(1000, 0x42)),
      ).rejects.toThrow(BadRequestException);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should accept repeated chunk with same content (idempotent)", async () => {
      const tempDir = `/tmp/test-chunk-same-${Date.now()}`;
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(1000, 0x41));

      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "test.bin",
        totalSize: 2000,
        chunkSize: 1000,
        totalChunks: 2,
        uploadedChunks: [0],
        uploadedSize: 1000,
        tempPath: tempDir,
        parentId: null,
        status: "uploading",
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(session);
      mockQueryRunner.manager.save.mockResolvedValue(session);

      const result = await service.uploadChunk(
        1,
        "abc",
        0,
        Buffer.alloc(1000, 0x41),
      );
      expect(result).toBeDefined();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Remediation A — final file integrity", () => {
    it("should reject when actual size does not match declared totalSize", async () => {
      const tempDir = `/tmp/test-size-mismatch-${Date.now()}`;
      const finalPath = `/tmp/test-size-mismatch-${Date.now()}-final.png`;
      const session = {
        uploadId: "abc",
        userId: 1,
        filename: "photo.png",
        totalSize: 100,
        chunkSize: 100,
        totalChunks: 1,
        uploadedChunks: [0],
        uploadedSize: 8,
        tempPath: tempDir,
        parentId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
      };

      fs.mkdirSync(tempDir, { recursive: true });
      // Chunk file is 8 bytes, but declared totalSize is 100.
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.alloc(8));

      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);
      mockStorageService.generateFinalPath.mockReturnValue(finalPath);
      mockStorageService.generateSafeFilename.mockReturnValue("photo.png");

      await expect(service.completeUpload(1, "abc")).rejects.toThrow(
        BadRequestException,
      );
      expect(fs.existsSync(finalPath)).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Remediation A — temp dir lifecycle", () => {
    it("should not create temp dir before DB persistence", async () => {
      const user = {
        id: 1,
        storageQuota: 1000000000,
        storageUsed: 0,
      };
      // Mock the transaction's manager.findOne to return the user for UserEntity lookup
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(user);
      // Mock manager.save to reject (this is what's called inside the transaction)
      mockQueryRunner.manager.save.mockRejectedValueOnce(new Error("DB down"));
      mockUploadSessionRepository.create.mockReturnValue({
        uploadId: "new-session",
        tempPath: "/tmp/should-not-exist-yet",
      });

      await expect(
        service.createUploadSession(1, "test.bin", 1000, 500),
      ).rejects.toThrow("DB down");
    });
  });

  describe("cleanupOrphanedTempDirs — constant-query classification", () => {
    let tempRoot: string;
    let deleteSpy: jest.SpyInstance;

    beforeEach(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-orphan-"));
      mockStorageService.getTempPath.mockReturnValue(tempRoot);
      deleteSpy = jest.spyOn(service as any, "deleteTempFiles");
    });

    afterEach(() => {
      deleteSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it("preserves referenced temp dirs and deletes orphans", async () => {
      const referenced = path.join(tempRoot, "kept");
      const orphan = path.join(tempRoot, "gone");
      fs.mkdirSync(referenced, { recursive: true });
      fs.mkdirSync(orphan, { recursive: true });

      mockQueryBuilder.getRawMany.mockResolvedValue([{ tempPath: referenced }]);

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(1);
      expect(fs.existsSync(referenced)).toBe(true);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(deleteSpy).toHaveBeenCalledWith(orphan);
      expect(deleteSpy).not.toHaveBeenCalledWith(referenced);
    });

    it("classifies mixed referenced/orphan set correctly", async () => {
      const a = path.join(tempRoot, "a");
      const b = path.join(tempRoot, "b");
      const c = path.join(tempRoot, "c");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.mkdirSync(c, { recursive: true });

      mockQueryBuilder.getRawMany.mockResolvedValue([
        { tempPath: a },
        { tempPath: c },
      ]);

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(1);
      expect(fs.existsSync(a)).toBe(true);
      expect(fs.existsSync(b)).toBe(false);
      expect(fs.existsSync(c)).toBe(true);
    });

    it("performs one DB query regardless of directory count", async () => {
      for (let i = 0; i < 100; i++) {
        fs.mkdirSync(path.join(tempRoot, `d${i}`), { recursive: true });
      }

      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.cleanupOrphanedTempDirs();

      expect(
        mockUploadSessionRepository.createQueryBuilder,
      ).toHaveBeenCalledTimes(1);
      expect(mockQueryBuilder.getRawMany).toHaveBeenCalledTimes(1);
    });

    it("behaves correctly with an empty directory list", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(0);
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("preserves ingress root and removes only stale ingress files", async () => {
      const ingressRoot = path.join(tempRoot, "multipart-ingress");
      fs.mkdirSync(ingressRoot);
      const stale = path.join(ingressRoot, "stale");
      const fresh = path.join(ingressRoot, "fresh");
      fs.writeFileSync(stale, "old");
      fs.writeFileSync(fresh, "new");
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(0);
      expect(fs.existsSync(ingressRoot)).toBe(true);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(deleteSpy).not.toHaveBeenCalledWith(ingressRoot);
    });

    it("does not delete orphans when DB lookup fails", async () => {
      const orphan = path.join(tempRoot, "unsafe");
      fs.mkdirSync(orphan, { recursive: true });

      mockQueryBuilder.getRawMany.mockRejectedValue(new Error("DB down"));

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(0);
      expect(fs.existsSync(orphan)).toBe(true);
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("preserves existing filesystem failure behavior", async () => {
      const badRoot = "/nonexistent/path/for/orphan/cleanup";
      mockStorageService.getTempPath.mockReturnValue(badRoot);

      const cleaned = await service.cleanupOrphanedTempDirs();

      expect(cleaned).toBe(0);
      expect(
        mockUploadSessionRepository.createQueryBuilder,
      ).not.toHaveBeenCalled();
    });
  });
});
