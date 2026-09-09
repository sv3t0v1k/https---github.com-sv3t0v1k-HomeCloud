import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader) return false;

    const [type, token] = authHeader.split(" ");
    if (type !== "Bearer") return false;

    try {
      const payload = this.jwtService.verify(token);
      request.user = { userId: payload.sub, email: payload.email };
      return true;
    } catch {
      return false;
    }
  }
}
