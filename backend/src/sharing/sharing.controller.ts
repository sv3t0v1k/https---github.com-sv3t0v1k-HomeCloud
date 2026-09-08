import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../auth/guards/jwt.guard';
import { SharingService } from './sharing.service';
import { CreateShareDto } from './dtos/create-share.dto';

class VerifyPasswordDto {
  password: string;
}

@Controller('sharing')
export class SharingController {
  constructor(private sharingService: SharingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtGuard)
  async createShareLink(@Request() req, @Body() dto: CreateShareDto) {
    const userId = req.user.userId;
    return this.sharingService.createShareLink(userId, dto.fileId, {
      password: dto.password,
      expiresInDays: dto.expiresInDays,
      isFolder: dto.isFolder,
    });
  }

  @Get()
  @UseGuards(JwtGuard)
  async listShares(@Request() req) {
    const userId = req.user.userId;
    return this.sharingService.listUserShares(userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtGuard)
  async revokeShare(@Request() req, @Param('id') id: string) {
    const userId = req.user.userId;
    return this.sharingService.revokeShare(userId, parseInt(id, 10));
  }

  @Get('public/:token')
  async getPublicShare(@Param('token') token: string) {
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

  @Post('public/:token/verify')
  async verifyPassword(@Param('token') token: string, @Body() dto: VerifyPasswordDto) {
    const result = await this.sharingService.verifySharePassword(token, dto.password);
    return { success: result };
  }

  @Post('public/:token/download')
  @HttpCode(HttpStatus.OK)
  async downloadShare(@Param('token') token: string, @Body() dto: VerifyPasswordDto) {
    const share = await this.sharingService.findShareByToken(token);

    if (share.password && !dto.password) {
      throw new Error('Password is required');
    }

    if (share.password) {
      await this.sharingService.verifySharePassword(token, dto.password);
    }

    await this.sharingService.incrementDownloadCount(token);

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
}
