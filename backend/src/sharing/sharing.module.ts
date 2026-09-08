import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShareLinkEntity } from '../entities/share-link.entity';
import { FilesModule } from '../files/files.module';
import { AuthModule } from '../auth/auth.module';
import { SharingService } from './sharing.service';
import { SharingController } from './sharing.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ShareLinkEntity]),
    FilesModule,
    AuthModule,
  ],
  providers: [SharingService],
  controllers: [SharingController],
  exports: [SharingService],
})
export class SharingModule {}
