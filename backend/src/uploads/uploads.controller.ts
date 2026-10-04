import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  UseGuards,
  Request as NestRequest,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { UploadsService } from "./uploads.service";
import { CreateSessionDto } from "./dtos/create-session.dto";
import { ChunkDto } from "./dtos/chunk.dto";
import { Request as ExpressRequest } from "express";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";
import { IngressChunkFile } from "./chunk-ingress";
import {
  UploadRateLimitInterceptor,
  markUploadProcessing,
} from "./upload-rate-limit";

interface UploadedChunkFile {
  path: string;
  size: number;
}

@Controller("uploads")
@UseGuards(JwtGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Get("limits")
  getLimits(@NestRequest() req: ExpressRequest & { user: { userId: number } }) {
    return this.uploadsService.getUploadLimits(req.user.userId);
  }

  @Post("session")
  @HttpCode(HttpStatus.CREATED)
  async createSession(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: CreateSessionDto,
  ) {
    const userId = req.user.userId;
    return this.uploadsService.createUploadSession(
      userId,
      dto.filename,
      dto.totalSize,
      dto.chunkSize,
      dto.parentId,
    );
  }

  @Post("session/:uploadId/chunk")
  @UseInterceptors(
    UploadRateLimitInterceptor,
    IngressFileCleanupInterceptor,
    FileInterceptor("chunk"),
  )
  @HttpCode(HttpStatus.OK)
  async uploadChunk(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("uploadId") uploadId: string,
    @Body() dto: ChunkDto,
    @UploadedFile() chunk: UploadedChunkFile,
  ) {
    const userId = req.user.userId;

    if (!chunk) {
      throw new BadRequestException("Chunk file is required");
    }

    markUploadProcessing(req);
    return this.uploadsService.uploadChunk(userId, uploadId, dto.chunkIndex, {
      path: chunk.path,
      size: chunk.size,
    } satisfies IngressChunkFile);
  }

  @Post("session/:uploadId/complete")
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("uploadId") uploadId: string,
  ) {
    const userId = req.user.userId;
    return this.uploadsService.completeUpload(userId, uploadId);
  }

  @Delete("session/:uploadId")
  @UseInterceptors(UploadRateLimitInterceptor)
  @HttpCode(HttpStatus.OK)
  async abortUpload(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Param("uploadId") uploadId: string,
  ) {
    const userId = req.user.userId;
    return this.uploadsService.abortUpload(userId, uploadId);
  }

  @Get("sessions")
  async listSessions(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const userId = req.user.userId;
    return this.uploadsService.listUploadSessions(userId);
  }
}
