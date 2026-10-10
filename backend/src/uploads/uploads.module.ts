import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadsService } from "./uploads.service";
import { UploadsController } from "./uploads.controller";
import { StorageService } from "../storage/storage.service";
import { StorageModule } from "../storage/storage.module";
import { FilesModule } from "../files/files.module";
import { UsersModule } from "../users/users.module";
import { AuthModule } from "../auth/auth.module";
import { MulterModule } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import { getMulterFileSizeLimit } from "./chunk-ingress";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";
import {
  UploadRateLimitService,
  UploadRateLimitInterceptor,
} from "./upload-rate-limit";
import { abortableDiskStorage } from "./abortable-disk-storage";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UploadSessionEntity,
      UploadChunkEntity,
      FileEntity,
      FolderEntity,
    ]),
    StorageModule,
    FilesModule,
    UsersModule,
    AuthModule,
    MulterModule.registerAsync({
      imports: [StorageModule],
      inject: [ConfigService, StorageService],
      useFactory: (configService: ConfigService, storageService: StorageService) => {
        const ingressPath = path.join(storageService.getTempPath(), "multipart-ingress");
        const guard = (target: string) => { storageService.assertTrustedPath(target); };
        guard(ingressPath);
        fs.mkdirSync(ingressPath, { recursive: true });
        return {
          storage: abortableDiskStorage(ingressPath, guard),
          limits: {
            fileSize: getMulterFileSizeLimit(
              configService.get("MAX_CHUNK_SIZE"),
            ),
            files: 1,
            fields: 1,
            // Busboy emits partsLimit at the limit itself; two valid parts need 3.
            parts: 3,
            fieldSize: 32,
            fieldNameSize: 64,
          },
        };
      },
    }),
  ],
  providers: [
    UploadsService,
    IngressFileCleanupInterceptor,
    UploadRateLimitService,
    UploadRateLimitInterceptor,
  ],
  controllers: [UploadsController],
  exports: [UploadsService, UploadRateLimitService],
})
export class UploadsModule {}
