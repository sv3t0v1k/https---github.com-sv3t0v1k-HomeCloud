import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';
import { CreateSessionDto } from './dtos/create-session.dto';
import { ChunkDto } from './dtos/chunk.dto';

@Controller('uploads')
@UseGuards(JwtGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  async createSession(@Request() req, @Body() dto: CreateSessionDto) {
    const userId = req.user.userId;
    return this.uploadsService.createUploadSession(
      userId,
      dto.filename,
      dto.totalSize,
      dto.chunkSize,
      dto.parentId,
    );
  }

  @Post('session/:uploadId/chunk')
  @UseInterceptors(FileInterceptor('chunk'))
  @HttpCode(HttpStatus.OK)
  async uploadChunk(
    @Request() req,
    @Param('uploadId') uploadId: string,
    @Body() dto: ChunkDto,
    @UploadedFile() chunk: Express.Multer.File,
  ) {
    const userId = req.user.userId;

    if (!chunk) {
      throw new BadRequestException('Chunk file is required');
    }

    return this.uploadsService.uploadChunk(
      userId,
      uploadId,
      dto.chunkIndex,
      chunk.buffer,
    );
  }

  @Post('session/:uploadId/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(@Request() req, @Param('uploadId') uploadId: string) {
    const userId = req.user.userId;
    return this.uploadsService.completeUpload(userId, uploadId);
  }

  @Delete('session/:uploadId')
  @HttpCode(HttpStatus.OK)
  async abortUpload(@Request() req, @Param('uploadId') uploadId: string) {
    const userId = req.user.userId;
    return this.uploadsService.abortUpload(userId, uploadId);
  }

  @Get('sessions')
  async listSessions(@Request() req) {
    const userId = req.user.userId;
    return this.uploadsService.listUploadSessions(userId);
  }
}
