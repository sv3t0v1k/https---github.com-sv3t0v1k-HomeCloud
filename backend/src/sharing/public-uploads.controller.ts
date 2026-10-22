import {
  ArgumentsHost,
  BadRequestException,
  Body,
  CanActivate,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Injectable,
  Param,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Request, Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  Matches,
} from "class-validator";
import { PublicUploadsService } from "./public-uploads.service";
import {
  PUBLIC_UPLOAD,
  PublicUploadAdmission,
} from "../uploads/public-upload-access";
import {
  UploadRateLimitInterceptor,
  markUploadProcessing,
} from "../uploads/upload-rate-limit";
import { IngressFileCleanupInterceptor } from "../uploads/ingress-file-cleanup.interceptor";
import { ChunkDto } from "../uploads/dtos/chunk.dto";

type PublicRequest = Request & { [PUBLIC_UPLOAD]?: PublicUploadAdmission };
class PublicCreateSessionDto {
  @IsInt() @Min(1) parentId!: number;
  @IsString() @MaxLength(255) filename!: string;
  @IsInt() @Min(1) totalSize!: number;
  @IsInt() @Min(1) chunkSize!: number;
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedSha256?: string;
}

@Injectable()
export class PublicUploadGuard implements CanActivate {
  constructor(private readonly uploads: PublicUploadsService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<PublicRequest>();
    if (!req.secure) throw new ForbiddenException("HTTPS is required");
    const token = req.params.token;
    if (typeof token !== "string") throw new ForbiddenException();
    const value = req.headers["x-share-upload-proof"];
    const proof = typeof value === "string" ? value : undefined;
    await this.uploads.authorizeRequest(token, proof);
    if (
      req.method === "DELETE" ||
      (req.method === "POST" && /\/chunk\/?$/.test(req.path))
    )
      req[PUBLIC_UPLOAD] = await this.uploads.admit(
        token,
        proof,
        String(req.params.uploadId),
      );
    return true;
  }
}

@Catch()
export class PublicUploadExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const messages: Record<number, string> = {
      400: "Invalid upload request",
      401: "Public upload authorization required",
      403: "Public upload not allowed",
      404: "Share or upload unavailable",
      409: "Upload conflict; retry or check status",
      413: "Upload is too large",
      429: "Upload busy; retry later",
      503: "Upload unavailable",
    };
    response.setHeader("Cache-Control", "no-store");
    if (status === 429) response.setHeader("Retry-After", "1");
    response
      .status(status)
      .json({
        statusCode: status,
        message: messages[status] ?? "Upload failed",
      });
  }
}

@Controller("sharing/public/:token/uploads/session")
@UseGuards(PublicUploadGuard)
@UseFilters(PublicUploadExceptionFilter)
export class PublicUploadsController {
  constructor(private readonly uploads: PublicUploadsService) {}

  @Post()
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  create(
    @Param("token") token: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: PublicCreateSessionDto,
  ) {
    return this.uploads.create(token, proof, key, dto);
  }

  @Post(":uploadId/chunk")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseInterceptors(
    UploadRateLimitInterceptor,
    IngressFileCleanupInterceptor,
    FileInterceptor("chunk"),
  )
  chunk(
    @Req() req: PublicRequest,
    @Param("token") token: string,
    @Param("uploadId") uploadId: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
    @Body() dto: ChunkDto,
    @UploadedFile() file: { path: string; size: number },
  ) {
    if (!file) throw new BadRequestException("Chunk required");
    markUploadProcessing(req);
    return this.uploads.chunk(token, proof, uploadId, dto.chunkIndex, {
      path: file.path,
      size: file.size,
    });
  }

  @Get(":uploadId")
  @Header("Cache-Control", "no-store")
  status(
    @Param("token") token: string,
    @Param("uploadId") uploadId: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
  ) {
    return this.uploads.status(token, proof, uploadId);
  }

  @Post(":uploadId/complete")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  complete(
    @Param("token") token: string,
    @Param("uploadId") uploadId: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
  ) {
    return this.uploads.complete(token, proof, uploadId);
  }

  @Delete(":uploadId")
  @UseInterceptors(UploadRateLimitInterceptor)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  abort(
    @Param("token") token: string,
    @Param("uploadId") uploadId: string,
    @Headers("x-share-upload-proof") proof: string | undefined,
  ) {
    return this.uploads.abort(token, proof, uploadId);
  }
}
