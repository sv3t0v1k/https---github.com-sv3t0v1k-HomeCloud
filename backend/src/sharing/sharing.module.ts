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
  ],
  providers: [SharingService, PublicFolderService],
  controllers: [SharingController, PublicFolderController],
  exports: [SharingService],
})
export class SharingModule {}
