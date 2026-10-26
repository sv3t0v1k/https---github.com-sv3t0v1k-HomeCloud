import { Controller, ForbiddenException, Get, Request, UseGuards } from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { UpdatesService } from "./updates.service";

@Controller("updates")
@UseGuards(JwtGuard)
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get("access")
  access(@Request() req: ExpressRequest & { user: { userId: number } }) {
    return { admin: this.updates.isAdmin(req.user.userId) };
  }

  @Get()
  check(@Request() req: ExpressRequest & { user: { userId: number } }) {
    if (!this.updates.isAdmin(req.user.userId)) throw new ForbiddenException();
    return this.updates.check();
  }
}
