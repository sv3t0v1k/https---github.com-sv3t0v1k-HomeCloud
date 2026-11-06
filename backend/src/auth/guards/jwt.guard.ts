import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { bearerTokenFromHeader } from "./bearer-token";
import { JwtPayload, JwtStrategy } from "../jwt.strategy";

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private jwtStrategy: JwtStrategy,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Request>();
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (!Number.isSafeInteger(payload?.sub) || payload.sub <= 0) {
      throw new UnauthorizedException();
    }
    request.user = await this.jwtStrategy.validate(payload);
    return true;
  }
}
