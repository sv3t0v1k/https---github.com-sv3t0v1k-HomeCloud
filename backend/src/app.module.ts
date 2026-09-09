import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { FilesModule } from "./files/files.module";
import { UploadsModule } from "./uploads/uploads.module";
import { SharingModule } from "./sharing/sharing.module";
import { PreviewsModule } from "./previews/previews.module";
import { StorageModule } from "./storage/storage.module";
import { CommonModule } from "./common/common.module";
import { HealthController } from "./common/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", ".env.local"],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        url: configService.get("DATABASE_URL"),
        synchronize: process.env.NODE_ENV !== "production",
        logging: process.env.NODE_ENV !== "production",
        entities: [__dirname + "/**/*.entity{.js,.ts}"],
        migrations: [__dirname + "/migrations/*{.ts,.js}"],
        cli: {
          migrationsDir: __dirname + "/migrations",
        },
        extra: {
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        },
      }),
    }),
    AuthModule,
    UsersModule,
    FilesModule,
    UploadsModule,
    SharingModule,
    PreviewsModule,
    StorageModule,
    CommonModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
