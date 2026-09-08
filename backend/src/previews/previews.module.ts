import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../entities/file.entity';
import { PreviewsService } from './previews.service';
import { PreviewsController } from './previews.controller';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FileEntity]),
    StorageModule,
    AuthModule,
  ],
  providers: [PreviewsService],
  controllers: [PreviewsController],
  exports: [PreviewsService],
})
export class PreviewsModule {}
