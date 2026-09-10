import { UploadsService } from "./uploads.service";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { ForbiddenException, BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

jest.mock("file-type", () => ({
  fileTypeFromBuffer: jest.fn(),
}), { virtual: true });

import { fileTypeFromBuffer } from "file-type";

describe("UploadsService - Post-Review Fixes", () => {
  let service: UploadsService;
  let mockUploadSessionRepository: any;
  let mockFileRepository: any;
  let mockFolderRepository: any;
  let mockStorageService: any;
  let mockUsersService: any;
  let mockConfigService: any;
  let mockQueryRunner: any;

  beforeEach(() => {
    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        save: jest.fn(),
      },
    };
    mockUploadSessionRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
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
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => ({
            startTransaction: jest.fn(),
            commitTransaction: jest.fn(),
            rollbackTransaction: jest.fn(),
            release: jest.fn(),
            manager: {
              findOne: jest.fn(),
              save: jest.fn(),
            },
          })),
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

      await expect(
        localService.createUploadSession(1, "test.bin", 200_000_000, 1024),
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

      await expect(
        localService.createUploadSession(1, "test.bin", 200_000_000, 1024),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("uploadChunk - strict size enforcement", () => {
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
      const results = await Promise.all(promises);

      const chunkPath = path.join(tempDir, "0");
      expect(fs.existsSync(chunkPath)).toBe(true);
      const actualSize = fs.statSync(chunkPath).size;
      expect(actualSize).toBe(1000);

      const resultA = results[0];
      const resultB = results[1];
      expect(resultA.uploadedChunks.filter((c) => c === 0).length).toBe(1);
      expect(resultB.uploadedChunks.filter((c) => c === 0).length).toBe(1);

      const totalUploadedSize = resultA.uploadedSize + resultB.uploadedSize;
      expect(totalUploadedSize).toBeLessThanOrEqual(2000);

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
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.from("MZ\x00\x00\x00\x00\x00\x00\x00\x00"));
      fs.writeFileSync(finalPath, Buffer.from("MZ\x00\x00\x00\x00\x00\x00\x00\x00"));

      mockUploadSessionRepository.findOne.mockResolvedValue(session);
      mockUploadSessionRepository.save.mockResolvedValue(session);
      mockStorageService.generatePath.mockReturnValue(finalPath);

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({ mime: "application/x-msdownload" });

      await expect(service.completeUpload(1, "abc")).rejects.toThrow(
        BadRequestException,
      );

      expect(mockFileRepository.save).not.toHaveBeenCalled();
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
      fs.writeFileSync(path.join(tempDir, "0"), Buffer.from("MZ\x00\x00\x00\x00\x00\x00\x00\x00"));
      fs.writeFileSync(finalPath, Buffer.from("MZ\x00\x00\x00\x00\x00\x00\x00\x00"));

      mockUploadSessionRepository.findOne.mockResolvedValue(session);
      mockUploadSessionRepository.save.mockResolvedValue(session);
      mockStorageService.generatePath.mockReturnValue(finalPath);
      mockFileRepository.save.mockResolvedValue({ id: 1 });
      mockFileRepository.create.mockReturnValue({ id: 1, name: "final.jpg", storagePath: finalPath, size: 8, mimeType: "image/jpeg", isFolder: false, userId: 1 });
      mockUsersService.updateStorageUsed.mockRejectedValue(
        new ForbiddenException("Storage quota exceeded"),
      );

      const mockQueryRunner = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(session),
          save: jest.fn(),
        },
      };
      mockFileRepository.manager.connection.createQueryRunner.mockReturnValue(mockQueryRunner);

      (fileTypeFromBuffer as jest.Mock).mockResolvedValue({ mime: "image/jpeg" });

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
});
