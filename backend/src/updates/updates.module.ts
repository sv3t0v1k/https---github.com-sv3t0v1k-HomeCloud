import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";

@Module({
  imports: [AuthModule],
  controllers: [UpdatesController],
  providers: [UpdatesService, UpdateInstallService],
})
export class UpdatesModule {}
