import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { bearerTokenFromHeader } from "./bearer-token";

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Request>();
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    try {
      const payload = this.jwtService.verify(token);
      if (!Number.isSafeInteger(payload?.sub) || payload.sub <= 0) {
        throw new UnauthorizedException();
      }
      request.user = { userId: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
