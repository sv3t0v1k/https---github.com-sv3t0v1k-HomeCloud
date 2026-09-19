import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Request as NestRequest,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Res,
  NotFoundException,
} from "@nestjs/common";
import { Request as ExpressRequest, Response } from "express";
import * as fs from "fs";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { SharingService } from "./sharing.service";
import { StorageService } from "../storage/storage.service";
import { CreateShareDto } from "./dtos/create-share.dto";

class VerifyPasswordDto {
  password: string = "";
}

export type RangeParseResult =
  | { type: "none" }
  | { type: "range"; start: number; end: number }
  | { type: "unsatisfiable" };

/**
 * Parse an HTTP `Range` header (bytes unit, single range only) against a
 * resource of `fileSize` bytes.
 *
 * - "none"          -> no/invalid-to-parse Range -> whole file (HTTP 200).
 * - { start, end }  -> inclusive byte range -> HTTP 206.
 * - "unsatisfiable" -> range present but invalid or not satisfiable -> HTTP 416.
 *
 * `expiresAt`-style null-safe rule: an absent header yields "none". Empty /
 * non-bytes-unit / multiple-range headers fall through to "unsatisfiable".
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): RangeParseResult {
  if (!rangeHeader || rangeHeader.trim() === "") return { type: "none" };

  // Only a single `bytes=start-end` range is accepted. Multiple ranges,
  // non-bytes units or unparseable values are treated as unsatisfiable (416),
  // mirroring nginx semantics where absent/empty -> 200 full, malformed -> 416.
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { type: "unsatisfiable" };

  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;

  if (startStr === "") {
    // Suffix range: bytes=-N (last N bytes)
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { type: "unsatisfiable" };
    }
    if (suffix >= fileSize) {
      start = 0;
      end = fileSize - 1;
    } else {
      start = fileSize - suffix;
      end = fileSize - 1;
    }
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Number(endStr);
    if (!Number.isFinite(start) || (endStr !== "" && !Number.isFinite(end))) {
      return { type: "unsatisfiable" };
    }
  }

  if (start < 0 || end < 0) return { type: "unsatisfiable" };
  if (start > end) return { type: "unsatisfiable" };
  if (fileSize === 0) return { type: "unsatisfiable" };
  if (start >= fileSize) return { type: "unsatisfiable" };
  if (end >= fileSize) end = fileSize - 1; // clamp trailing bytes beyond EOF

  return { type: "range", start, end };
}

@Controller("sharing")
export class SharingController {
  constructor(
    private sharingService: SharingService,
    private storageService: StorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtGuard)
  async createShareLink(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: CreateShareDto,
  ) {
    const userId = req.user.userId;
    return this.sharingService.createShareLink(userId, dto.fileId, {
      password: dto.password,
      expiresInDays: dto.expiresInDays,
      isFolder: dto.isFolder,
    });
  }

  @Get()
  @UseGuards(JwtGuard)
  async listShares(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.sharingService.listUserShares(userId);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtGuard)
  async revokeShare(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("id") id: string,
  ) {
    const userId = req.user.userId;
    return this.sharingService.revokeShare(userId, parseInt(id, 10));
  }

  @Get("public/:token")
  async getPublicShare(@Param("token") token: string) {
    const share = await this.sharingService.findShareByToken(token);

    return {
      token: share.token,
      fileId: share.fileId,
      isFolder: share.isFolder,
      expiresAt: share.expiresAt,
      downloadCount: share.downloadCount,
      createdAt: share.createdAt,
      requiresPassword: !!share.password,
    };
  }

  @Post("public/:token/verify")
  async verifyPassword(
    @Param("token") token: string,
    @Body() dto: VerifyPasswordDto,
  ) {
    const result = await this.sharingService.verifySharePassword(
      token,
      dto.password,
    );
    return { success: result };
  }

  @Post("public/:token/download")
  @HttpCode(HttpStatus.OK)
  async downloadShare(
    @Param("token") token: string,
    @Body() dto: VerifyPasswordDto,
    @Res() res: Response,
    @Req() req?: ExpressRequest,
  ) {
    const share = await this.sharingService.findShareByToken(token);

    if (share.password && !dto.password) {
      throw new BadRequestException("Password is required");
    }

    if (share.password) {
      await this.sharingService.verifySharePassword(token, dto.password);
    }

    await this.sharingService.incrementDownloadCount(token);

    if (share.file.isFolder) {
      return {
        file: {
          id: share.file.id,
          name: share.file.name,
          mimeType: share.file.mimeType,
          size: share.file.size,
          isFolder: share.file.isFolder,
        },
      };
    }

    const filePath = share.file.storagePath;
    if (!filePath) {
      throw new NotFoundException("File not found on storage");
    }

    // Path confinement: refuse any path that resolves outside the storage root.
    let safePath: string;
    try {
      safePath = this.storageService.ensureWithinStorageRoot(filePath);
    } catch {
      throw new NotFoundException("File not found on storage");
    }

    if (!fs.existsSync(safePath)) {
      throw new NotFoundException("File not found on storage");
    }

    const stat = fs.statSync(safePath);
    const fileSize = stat.size;
    const fileName = share.file.name || "download";
    const safeFileName = fileName.replace(/"/g, '\\"');
    const mimeType = share.file.mimeType || "application/octet-stream";

    const rangeHeader = req?.headers?.range as string | undefined;
    const parsed = parseRangeHeader(rangeHeader, fileSize);

    if (parsed.type === "unsatisfiable") {
      res.status(416).set({
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${safeFileName}"`,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${fileSize}`,
      });
      res.end();
      return;
    }

    const baseHeaders = {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${safeFileName}"`,
      "Accept-Ranges": "bytes",
    };

    if (parsed.type === "none") {
      res.set({ ...baseHeaders, "Content-Length": String(fileSize) });
      this.streamFile(safePath, res);
      return;
    }

    const { start, end } = parsed;
    const length = end - start + 1;
    res.status(206).set({
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": String(length),
    });
    this.streamFile(safePath, res, start, end);
  }

  private streamFile(
    filePath: string,
    res: Response,
    start?: number,
    end?: number,
  ): void {
    const stream = fs.createReadStream(
      filePath,
      start !== undefined ? { start, end } : undefined,
    );

    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    // Cleanly tear down the stream if the client disconnects.
    res.on("close", () => {
      stream.destroy();
    });

    stream.pipe(res);
  }
}
