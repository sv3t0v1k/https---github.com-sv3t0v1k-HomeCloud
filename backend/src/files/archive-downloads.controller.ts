import {
  BadRequestException, Body, Controller, Get, Head, HttpCode, Param, Post,
  Req, Res, UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { JwtGuard } from "../auth/guards/jwt.guard";
import {
  ARCHIVE_COOKIE, ArchiveDownloadsService, ArchiveSelection, archiveCookiePath,
} from "./archive-downloads.service";

@Controller("files/download-archives")
export class ArchivePrepareController {
  constructor(private readonly archives: ArchiveDownloadsService, private readonly config: ConfigService) {}

  @Post("prepare")
  @UseGuards(JwtGuard)
  @HttpCode(200)
  async prepare(
    @Req() req: Request & { user: { userId: number } },
    @Body() body: { items?: ArchiveSelection[] },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "items")
      throw new BadRequestException("Invalid archive request");
    const { id, token } = await this.archives.prepare(req.user.userId, body.items);
    res.set("Cache-Control", "no-store");
    res.cookie(ARCHIVE_COOKIE, token, {
      httpOnly: true, sameSite: "strict", secure: this.config.get("NODE_ENV") === "production",
      path: archiveCookiePath(id), maxAge: 120_000,
    });
    return { downloadPath: `/native-download-archives/${id}`, expiresInSeconds: 120 };
  }
}

@Controller("native-download-archives")
export class NativeArchiveController {
  constructor(private readonly archives: ArchiveDownloadsService, private readonly config: ConfigService) {}

  @Head(":id")
  async head(@Req() req: Request, @Param("id") id: string, @Res() res: Response) {
    await this.archives.authorize(id, this.cookie(req), false);
    res.set({ "Cache-Control": "no-store", "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="homecloud-files.zip"', "Accept-Ranges": "none" });
    res.status(200).end();
  }

  @Get(":id")
  async download(@Req() req: Request, @Param("id") id: string, @Res() res: Response) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new BadRequestException("Invalid archive id");
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const { userId, manifest } = await this.archives.authorize(id, this.cookie(req), true);
    res.clearCookie(ARCHIVE_COOKIE, {
      httpOnly: true, sameSite: "strict", secure: this.config.get("NODE_ENV") === "production",
      path: archiveCookiePath(id),
    });
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="homecloud-files.zip"`,
      "Accept-Ranges": "none",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(120_000, () => res.destroy());
    const maxDuration = setTimeout(() => res.destroy(), 4 * 60 * 60 * 1000);
    maxDuration.unref();
    try { await this.archives.stream(userId, manifest, res); }
    catch (error) {
      if (!res.headersSent) throw error;
      res.destroy();
    } finally { clearTimeout(maxDuration); }
  }

  private cookie(req: Request): string | undefined {
    return (req.headers.cookie || "")
      .split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${ARCHIVE_COOKIE}=`))
      ?.slice(ARCHIVE_COOKIE.length + 1);
  }
}
