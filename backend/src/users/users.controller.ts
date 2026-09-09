import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Request as NestRequest,
} from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { UsersService } from "./users.service";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { UpdateProfileDto } from "./dtos/update-profile.dto";

@Controller("users")
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get("me")
  @UseGuards(JwtGuard)
  async getMe(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const user = await this.usersService.findById(req.user.userId);
    if (!user) {
      return { error: "User not found" };
    }
    const { password: _password, ...safeUser } = user; // eslint-disable-line @typescript-eslint/no-unused-vars
    return safeUser;
  }

  @Patch("me")
  @UseGuards(JwtGuard)
  async updateProfile(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: UpdateProfileDto,
  ) {
    const user = await this.usersService.updateProfile(req.user.userId, dto);
    const { password: _password, ...safeUser } = user; // eslint-disable-line @typescript-eslint/no-unused-vars
    return safeUser;
  }
}
