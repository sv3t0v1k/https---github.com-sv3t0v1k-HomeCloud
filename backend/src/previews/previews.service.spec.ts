import { ConfigService } from "@nestjs/config";
import * as os from "os";
import { PreviewsService } from "./previews.service";
import { FileEntity } from "../entities/file.entity";
import { StorageService } from "../storage/storage.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from("fake-thumbnail")),
  })),
}));

describe("PreviewsService - Post-Review Fixes", () => {
  let service: PreviewsService;
  let mockFileRepository: any;
  let mockStorageService: any;

  beforeEach(() => {
    mockFileRepository = {
      findOne: jest.fn(),
    };
    mockStorageService = {
      resolveFilePath: jest.fn((file) => file.storagePath),
      placementForPath: jest.fn((storagePath: string) => ({ storagePath, storageLocationId: "f2f5c4b0-8d57-4c49-9f8c-0d095b344601", relativeObjectKey: storagePath.replace(/^\/storage\//, "") })),
      fileExists: jest.fn(),
    };

    service = new PreviewsService(
      mockFileRepository,
      mockStorageService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("getThumbnail - memory safety", () => {
    it("should reject large image before reading into memory", async () => {
      const tempFile = path.join("/tmp", `large-${Date.now()}.jpg`);
      const largeSize = 10 * 1024 * 1024;
      fs.writeFileSync(tempFile, Buffer.alloc(largeSize));

      mockFileRepository.findOne.mockResolvedValue({
        id: 1,
        userId: 1,
        storagePath: tempFile,
        mimeType: "image/jpeg",
      });
      mockStorageService.fileExists.mockReturnValue(true);

      await expect(service.getThumbnail(1, 1)).rejects.toThrow(
        BadRequestException,
      );

      fs.rmSync(tempFile, { force: true });
    });

    it("should accept small valid image", async () => {
      const tempFile = path.join("/tmp", `small-${Date.now()}.jpg`);
      fs.writeFileSync(tempFile, Buffer.alloc(1024));

      mockFileRepository.findOne.mockResolvedValue({
        id: 1,
        userId: 1,
        storagePath: tempFile,
        mimeType: "image/jpeg",
      });
      mockStorageService.fileExists.mockReturnValue(true);

      const result = await service.getThumbnail(1, 1);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);

      fs.rmSync(tempFile, { force: true });
    });
  });

  describe("getPreview - memory safety", () => {
    it("should reject large image before reading into memory", async () => {
      const tempFile = path.join("/tmp", `large-preview-${Date.now()}.jpg`);
      const largeSize = 10 * 1024 * 1024;
      fs.writeFileSync(tempFile, Buffer.alloc(largeSize));

      mockFileRepository.findOne.mockResolvedValue({
        id: 1,
        userId: 1,
        storagePath: tempFile,
        mimeType: "image/jpeg",
      });
      mockStorageService.fileExists.mockReturnValue(true);

      await expect(service.getPreview(1, 1)).rejects.toThrow(
        BadRequestException,
      );

      fs.rmSync(tempFile, { force: true });
    });
  });
});


describe("PreviewsService logical placement with real storage resolver", () => {
  let root: string;
  let storage: StorageService;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(),"hc-preview-placement-"));
    storage = new StorageService(new ConfigService({STORAGE_PATH:root}));
  });
  afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
  it("reads text preview and thumbnail from the logical object, rejecting mismatched bridge", async () => {
    const target=path.join(root,"text.txt"); fs.writeFileSync(target,"logical preview");
    const file={id:1,userId:1,mimeType:"text/plain",...storage.placementForPath(target)};
    const repo={findOne:jest.fn().mockResolvedValue(file)};
    const service=new PreviewsService(repo as any,storage);
    expect(await service.getPreview(1,1)).toMatchObject({content:"logical preview",type:"text"});
    file.mimeType="image/png";
    expect(await service.getThumbnail(1,1)).toEqual(Buffer.from("fake-thumbnail"));
    file.storagePath=path.join(root,"other.txt"); fs.writeFileSync(file.storagePath,"wrong");
    await expect(service.getPreview(1,1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getThumbnail(1,1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
