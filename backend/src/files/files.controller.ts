import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request as NestRequest,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Res,
} from "@nestjs/common";
import { Request as ExpressRequest, Response } from "express";
import * as fs from "fs";
import { IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { FilesService } from "./files.service";
import { StorageService } from "../storage/storage.service";

type RangeParseResult =
  | { type: "none" }
  | { type: "range"; start: number; end: number }
  | { type: "unsatisfiable" };

export function parseDownloadRange(
  rangeHeader: string | undefined,
  fileSize: number,
): RangeParseResult {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    return { type: "unsatisfiable" };
  }
  if (!rangeHeader || rangeHeader.trim() === "") return { type: "none" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { type: "unsatisfiable" };

  const startText = match[1];
  const endText = match[2];
  let start: number;
  let end: number;

  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || fileSize === 0) {
      return { type: "unsatisfiable" };
    }
    start = suffix >= fileSize ? 0 : fileSize - suffix;
    end = fileSize - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? fileSize - 1 : Number(endText);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      fileSize === 0
    ) {
      return { type: "unsatisfiable" };
    }
  }

  if (start < 0 || end < 0 || start > end || start >= fileSize) {
    return { type: "unsatisfiable" };
  }
  if (end >= fileSize) end = fileSize - 1;

  return { type: "range", start, end };
}

class CreateFolderDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number;
}

class UpdateFileDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number | null;
}

class CopyFileDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  targetParentId?: number;
}

class MoveFileDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  targetParentId?: number;
}

@Controller("files")
@UseGuards(JwtGuard)
export class FilesController {
  constructor(
    private filesService: FilesService,
    private storageService: StorageService,
  ) {}

  @Get()
  async findAll(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("parentId") parentId?: string,
    @Query("search") search?: string,
  ) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findAll(userId, parentIdNum, search);
  }

  @Get("folders")
  async findFolders(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("parentId") parentId?: string,
  ) {
    const userId = req.user.userId;
    const parentIdNum = parentId ? parseInt(parentId, 10) : undefined;
    return this.filesService.findFolders(userId, parentIdNum);
  }

  @Get("folders/:id")
  async findFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    if (!/^[1-9]\d*$/.test(id)) {
      throw new BadRequestException("Invalid folder id");
    }
    const folderId = Number(id);
    if (!Number.isSafeInteger(folderId)) {
      throw new BadRequestException("Invalid folder id");
    }
    return this.filesService.findFolder(req.user.userId, folderId);
  }

  @Patch("folders/:id")
  async updateFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: UpdateFileDto,
  ) {
    return this.filesService.updateFolder(
      req.user.userId,
      parseInt(id, 10),
      dto,
    );
  }

  @Delete("folders/:id")
  @HttpCode(HttpStatus.OK)
  async removeFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    return this.filesService.removeFolder(req.user.userId, parseInt(id, 10));
  }

  @Post("folders/:id/restore")
  @HttpCode(HttpStatus.OK)
  async restoreFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    return this.filesService.restoreFolder(req.user.userId, parseInt(id, 10));
  }

  @Delete("folders/:id/permanent")
  @HttpCode(HttpStatus.OK)
  async deleteFolderPermanently(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    return this.filesService.deleteFolderPermanently(
      req.user.userId,
      parseInt(id, 10),
    );
  }

  @Get("trash")
  async getTrash(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.getTrash(userId);
  }

  @Post("empty-trash")
  @HttpCode(HttpStatus.OK)
  async emptyTrash(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.emptyTrash(userId);
  }

  @Get("search")
  async search(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Query("q") q?: string,
  ) {
    const userId = req.user.userId;
    if (!q) {
      throw new BadRequestException("Query parameter q is required");
    }
    return this.filesService.search(userId, q);
  }

  @Get("storage-info")
  async getStorageInfo(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.filesService.getStorageInfo(userId);
  }

  @Post("folders")
  @HttpCode(HttpStatus.CREATED)
  async createFolder(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: CreateFolderDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.createFolder(userId, dto.name, dto.parentId);
  }

  @Get(":id/download")
  async download(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    return streamOriginalDownload(
      this.filesService,
      this.storageService,
      req,
      id,
      res,
    );
  }

  @Get(":id")
  async findOne(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.findOne(userId, parseInt(id, 10));
  }

  @Patch(":id")
  async update(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: UpdateFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.updateFile(userId, parseInt(id, 10), dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async remove(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.removeFile(userId, parseInt(id, 10));
  }

  @Post(":id/restore")
  @HttpCode(HttpStatus.OK)
  async restore(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.restoreFile(userId, parseInt(id, 10));
  }

  @Delete(":id/permanent")
  @HttpCode(HttpStatus.OK)
  async deletePermanently(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.filesService.deleteFilePermanently(userId, parseInt(id, 10));
  }

  @Post(":id/copy")
  @HttpCode(HttpStatus.CREATED)
  async copy(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: CopyFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.copyFile(
      userId,
      parseInt(id, 10),
      dto.targetParentId,
    );
  }

  @Post(":id/move")
  @HttpCode(HttpStatus.OK)
  async move(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
    @Body() dto: MoveFileDto,
  ) {
    const userId = req.user.userId;
    return this.filesService.moveFile(
      userId,
      parseInt(id, 10),
      dto.targetParentId,
    );
  }
}

export async function streamOriginalDownload(
  filesService: FilesService,
  storageService: StorageService,
  req: ExpressRequest & { user: { userId: number } },
  id: string,
  res: Response,
) {
  if (
    !/^[1-9]\d*$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) > 2147483647
  )
    throw new BadRequestException("Invalid file id");
  const file = await filesService.findOne(req.user.userId, parseInt(id, 10));
  if (file.isFolder) {
    throw new BadRequestException("Folders cannot be downloaded as files");
  }
  if (file.isDeleted || !file.storagePath) {
    throw new NotFoundException("File not found");
  }

  let safePath: string;
  try {
    safePath = storageService.ensureWithinStorageRoot(file.storagePath);
    safePath = storageService.ensureWithinStorageRoot(
      fs.realpathSync(safePath),
    );
  } catch {
    throw new NotFoundException("File not found on storage");
  }

  let fd: number;
  try {
    fd = fs.openSync(safePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new NotFoundException("File not found on storage");
  }

  let streamOwnsDescriptor = false;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
      throw new NotFoundException("File not found on storage");
    }

    const fileSize = stat.size;
    // Keep the ASCII fallback and provide the exact safe Unicode name through
    // RFC 5987. Legacy control characters never reach either header parameter.
    const downloadName = [...(file.name || "download")]
      .map((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0xd800 && code <= 0xdfff)
          ? "_"
          : character;
      })
      .join("");
    const safeFileName = downloadName.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encodedFileName = encodeURIComponent(downloadName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const mimeType =
      file.mimeType &&
      /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.mimeType)
        ? file.mimeType
        : "application/octet-stream";
    const baseHeaders = {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const parsed = parseDownloadRange(req.headers.range, fileSize);

    if (parsed.type === "unsatisfiable") {
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).set({
        ...baseHeaders,
        "Content-Range": `bytes */${fileSize}`,
      });
      res.end();
      return;
    }

    if (parsed.type === "none") {
      res.set({ ...baseHeaders, "Content-Length": String(fileSize) });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      streamFile(safePath, res, fd);
      streamOwnsDescriptor = true;
      return;
    }

    const { start, end } = parsed;
    res.status(HttpStatus.PARTIAL_CONTENT).set({
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": String(end - start + 1),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    streamFile(safePath, res, fd, start, end);
    streamOwnsDescriptor = true;
  } finally {
    if (!streamOwnsDescriptor) fs.closeSync(fd);
  }
}

function streamFile(
  filePath: string,
  res: Response,
  fd: number,
  start?: number,
  end?: number,
): void {
  const stream = fs.createReadStream(
    filePath,
    start === undefined
      ? { fd, autoClose: true }
      : { fd, autoClose: true, start, end },
  );

  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).end();
    } else {
      res.destroy(error);
    }
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
