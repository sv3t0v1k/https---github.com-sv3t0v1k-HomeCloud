import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";

@Module({
  imports: [AuthModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
})
export class UpdatesModule {}
