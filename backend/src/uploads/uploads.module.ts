import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadsService } from "./uploads.service";
import { UploadsController } from "./uploads.controller";
import { StorageModule } from "../storage/storage.module";
import { FilesModule } from "../files/files.module";
import { UsersModule } from "../users/users.module";
import { AuthModule } from "../auth/auth.module";
import { MulterModule } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { diskStorage } from "multer";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getMulterFileSizeLimit, IngressRequestState } from "./chunk-ingress";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";

@Module({
  imports: [
    TypeOrmModule.forFeature([UploadSessionEntity, FileEntity, FolderEntity]),
    StorageModule,
    FilesModule,
    UsersModule,
    AuthModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const storageRoot = configService.get("STORAGE_PATH") || "/storage";
        const ingressPath = path.join(storageRoot, ".tmp", "multipart-ingress");
        fs.mkdirSync(ingressPath, { recursive: true });
        return {
          storage: diskStorage({
            destination: ingressPath,
            filename: (request, _file, callback) => {
              const filename = randomUUID();
              (request as IngressRequestState).ingressFilePath = path.join(
                ingressPath,
                filename,
              );
              callback(null, filename);
            },
          }),
          limits: {
            fileSize: getMulterFileSizeLimit(
              configService.get("MAX_CHUNK_SIZE"),
            ),
            files: 1,
          },
        };
      },
    }),
  ],
  providers: [UploadsService, IngressFileCleanupInterceptor],
  controllers: [UploadsController],
  exports: [UploadsService],
})
export class UploadsModule {}
