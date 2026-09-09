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

@Module({
  imports: [
    TypeOrmModule.forFeature([UploadSessionEntity, FileEntity, FolderEntity]),
    StorageModule,
    FilesModule,
    UsersModule,
    AuthModule,
  ],
  providers: [UploadsService],
  controllers: [UploadsController],
  exports: [UploadsService],
})
export class UploadsModule {}
