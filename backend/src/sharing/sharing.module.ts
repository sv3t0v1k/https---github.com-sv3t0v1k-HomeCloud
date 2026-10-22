import { UploadsModule } from "../uploads/uploads.module";
import { PublicUploadsService } from "./public-uploads.service";
import { PublicUploadsController, PublicUploadGuard } from "./public-uploads.controller";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "../entities/user.entity";
import { FileEntity } from "../entities/file.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FilesModule } from "../files/files.module";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { SharingService } from "./sharing.service";
import { SharingController } from "./sharing.controller";
import { PublicFolderController } from "./public-folder.controller";
import { PublicFolderService } from "./public-folder.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([ShareLinkEntity, FileEntity, UserEntity]),
    FilesModule,
    AuthModule,
    StorageModule,
    UploadsModule,
  ],
  providers: [SharingService, PublicFolderService, PublicUploadsService, PublicUploadGuard],
  controllers: [SharingController, PublicFolderController, PublicUploadsController],
  exports: [SharingService, PublicUploadsService],
})
export class SharingModule {}
