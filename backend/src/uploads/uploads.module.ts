import {
  UploadWorkspaceResolver,
  LEGACY_UPLOAD_WORKSPACE,
} from "./upload-workspace";
import { Injectable, Module } from "@nestjs/common";
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
import {
  MulterOptionsFactory,
  MulterModuleOptions,
} from "@nestjs/platform-express/multer/interfaces/files-upload-module.interface";
import { ConfigService } from "@nestjs/config";
import { getMulterFileSizeLimit } from "./chunk-ingress";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";
import {
  UploadRateLimitService,
  UploadRateLimitInterceptor,
} from "./upload-rate-limit";
import { abortableDiskStorage } from "./abortable-disk-storage";

@Injectable()
class SecureUploadMulterOptions implements MulterOptionsFactory {
  private readonly resolver: UploadWorkspaceResolver;
  constructor(
    private readonly configService: ConfigService,
    storageService: StorageService,
  ) {
    this.resolver = new UploadWorkspaceResolver(storageService);
  }
  onModuleDestroy(): void {
    this.resolver.close();
  }
  createMulterOptions(): MulterModuleOptions {
    const resolver = this.resolver;
    const ingressPath = resolver.ingress(LEGACY_UPLOAD_WORKSPACE);
    const guard = (target: string) => {
      resolver.assertPath(target);
    };
    guard(ingressPath);
    resolver.filesystem().mkdir(ingressPath);
    return {
      storage: abortableDiskStorage(ingressPath, guard, () =>
        resolver.filesystem(),
      ),
      limits: {
        fileSize: getMulterFileSizeLimit(
          this.configService.get("MAX_CHUNK_SIZE"),
        ),
        files: 1,
        fields: 1,
        // Busboy emits partsLimit at the limit itself; two valid parts need 3.
        parts: 3,
        fieldSize: 32,
        fieldNameSize: 64,
      },
    };
  }
}

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
      useClass: SecureUploadMulterOptions,
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
