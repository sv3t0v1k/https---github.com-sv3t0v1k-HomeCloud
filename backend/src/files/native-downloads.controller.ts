import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  NotFoundException,
  HttpCode,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { FilesService } from "./files.service";
import { StorageService } from "../storage/storage.service";
import { streamOriginalDownload } from "./files.controller";
import {
  DownloadCapabilityService,
  DOWNLOAD_CAPABILITY_COOKIE,
  DOWNLOAD_CAPABILITY_TTL_MS,
  downloadCookiePath,
} from "./download-capability.service";

@Controller("native-downloads")
export class NativeDownloadsController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly capabilities: DownloadCapabilityService,
    private readonly config: ConfigService,
  ) {}

  @Post(":id/prepare")
  @UseGuards(JwtGuard)
  @HttpCode(200)
  async prepare(
    @Req() req: Request & { user: { userId: number } },
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const fileId = this.parseId(id);
    const file = await this.files.findOne(req.user.userId, fileId);
    if (file.isFolder || file.isDeleted || !file.storagePath)
      throw new NotFoundException("File not found");
    const token = await this.capabilities.issue(req.user.userId, fileId);
    res.set("Cache-Control", "no-store");
    res.cookie(DOWNLOAD_CAPABILITY_COOKIE, token, {
      ...this.cookieOptions(fileId),
      maxAge: DOWNLOAD_CAPABILITY_TTL_MS,
    });
    return {
      downloadPath: `/native-downloads/${fileId}`,
      expiresInSeconds: 120,
    };
  }

  @Get(":id")
  async download(
    @Req() req: Request,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const fileId = this.parseId(id);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const value = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${DOWNLOAD_CAPABILITY_COOKIE}=`))
      ?.slice(DOWNLOAD_CAPABILITY_COOKIE.length + 1);
    const userId = await this.capabilities.authorize(
      value,
      fileId,
      req.method !== "HEAD",
    );
    if (req.method !== "HEAD")
      res.clearCookie(DOWNLOAD_CAPABILITY_COOKIE, this.cookieOptions(fileId));
    return streamOriginalDownload(
      this.files,
      this.storage,
      Object.assign(req, { user: { userId } }),
      id,
      res,
    );
  }

  private parseId(id: string) {
    if (
      !/^[1-9]\d*$/.test(id) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) > 2147483647
    )
      throw new BadRequestException("Invalid file id");
    return Number(id);
  }
  private cookieOptions(fileId: number) {
    return {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: this.config.get("NODE_ENV") === "production",
      path: downloadCookiePath(fileId),
    };
  }
}
