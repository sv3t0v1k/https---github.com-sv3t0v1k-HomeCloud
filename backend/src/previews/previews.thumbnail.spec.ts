import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

import { PreviewsService } from "./previews.service";

describe("Thumbnail processing with real Sharp", () => {
  let root: string;
  let imagePath: string;
  let mimeType: string;
  let service: PreviewsService;
  let findOne: jest.Mock;
  let parentId: number | null;
  let ancestorsVisible: boolean;
  let secureOpen: jest.Mock;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-thumbnail-"));
    imagePath = path.join(root, "image.png");
    mimeType = "image/png";
    parentId = null;
    ancestorsVisible = true;
    secureOpen = jest.fn((absolutePath: string) =>
      fs.openSync(
        absolutePath,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      ),
    );

    findOne = jest.fn(async ({ where }) => {
      if (where.userId !== 1 || where.isDeleted !== false) return null;
      return {
        id: 1,
        userId: 1,
        isDeleted: false,
        isFolder: false,
        mimeType,
        parentId,
      };
    });

    service = new PreviewsService(
      {
        findOne,
        manager: {
          transaction: async (run: (manager: any) => Promise<any>) =>
            run({
              findOne: (_entity: unknown, options: any) =>
                findOne(options),
              query: async (sql: string) =>
                sql.includes("WITH RECURSIVE ancestor_chain")
                  ? [{ visible: ancestorsVisible }]
                  : [{ id: 1 }],
            }),
        },
      } as any,
      {
        resolveFilePath: () => imagePath,
        openReadOnlyFileSecure: secureOpen,
      } as any,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("generates a bounded PNG from an image larger than 5 MiB", async () => {
    const width = 1800;
    const height = 1300;
    const source = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    expect(source.length).toBeGreaterThan(5 * 1024 * 1024);
    fs.writeFileSync(imagePath, source);

    const thumbnail = await service.getThumbnail(1, 1);
    const metadata = await sharp(thumbnail).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeLessThanOrEqual(300);
    expect(metadata.height).toBeLessThanOrEqual(300);
    expect(thumbnail.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("rejects a valid image exceeding the pixel ceiling", async () => {
    const source = await sharp({
      create: {
        width: 5000,
        height: 5000,
        channels: 3,
        background: "#eeeeee",
      },
    }).png().toBuffer();

    fs.writeFileSync(imagePath, source);

    await expect(service.getThumbnail(1, 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects MIME and image signature mismatch", async () => {
    const source = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: "#eeeeee",
      },
    }).png().toBuffer();

    fs.writeFileSync(imagePath, source);
    mimeType = "image/jpeg";

    await expect(service.getThumbnail(1, 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a symlink instead of following it", async () => {
    const target = path.join(root, "actual.png");
    fs.writeFileSync(target, Buffer.from("private"));
    fs.symlinkSync(target, imagePath);

    await expect(service.getThumbnail(1, 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails closed when secure open is unavailable", async () => {
    secureOpen.mockImplementationOnce(() => {
      throw new Error("secure open unavailable");
    });

    await expect(service.getThumbnail(1, 1))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(secureOpen).toHaveBeenCalledWith(imagePath);
  });

  it("refuses images below an invisible ancestor", async () => {
    parentId = 42;
    ancestorsVisible = false;

    await expect(service.getThumbnail(1, 1))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not query another owner's image", async () => {
    await expect(service.getThumbnail(2, 1))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 1, userId: 2, isDeleted: false },
    });
  });
});
