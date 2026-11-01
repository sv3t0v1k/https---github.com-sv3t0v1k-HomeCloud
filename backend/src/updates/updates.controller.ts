import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Request, UseGuards } from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { AuthGuard } from "@nestjs/passport";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";
import { IsString, Matches } from "class-validator";

class InstallRequestDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  manifestSha256!: string;
}

@Controller("updates")
@UseGuards(AuthGuard("jwt"))
export class UpdatesController {
  constructor(private readonly updates: UpdatesService, private readonly installation: UpdateInstallService) {}

  @Get("access")
  access(@Request() req: ExpressRequest & { user: { userId: number } }) {
    return { admin: this.updates.isAdmin(req.user.userId) };
  }

  @Get()
  check(@Request() req: ExpressRequest & { user: { userId: number } }) {
    if (!this.updates.isAdmin(req.user.userId)) throw new ForbiddenException();
    return this.updates.check();
  }
  @Get("installations/current")
  installationStatus(@Request() req: ExpressRequest & { user: { userId: number } }) {
    if (!this.updates.isAdmin(req.user.userId)) throw new ForbiddenException();
    return this.installation.status();
  }

  @Post("installations")
  @HttpCode(202)
  requestInstallation(@Request() req: ExpressRequest & { user: { userId: number } },
                      @Body() dto: InstallRequestDto) {
    if (!this.updates.isAdmin(req.user.userId)) throw new ForbiddenException();
    return this.installation.submit(dto.manifestSha256);
  }
}
