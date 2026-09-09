import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Request as NestRequest,
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
import { CreateShareDto } from "./dtos/create-share.dto";

class VerifyPasswordDto {
  password: string = "";
}

@Controller("sharing")
export class SharingController {
  constructor(private sharingService: SharingService) {}

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
    if (!filePath || !fs.existsSync(filePath)) {
      throw new NotFoundException("File not found on storage");
    }

    const fileName = share.file.name || "download";
    const safeFileName = fileName.replace(/"/g, '\\"');

    res.set({
      "Content-Type": share.file.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFileName}"`,
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }
}
