import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UserEntity } from "../entities/user.entity";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { bearerTokenFromHeader } from "./guards/bearer-token";

export interface JwtPayload {
  sub: number;
  email: string;
}

export interface UserInfo {
  userId: number;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: (request: Request) =>
        bearerTokenFromHeader(request.headers.authorization) ?? null,
      secretOrKey: configService.get("JWT_SECRET"),
    });
  }

  async validate(payload: JwtPayload): Promise<UserInfo> {
    if (!Number.isSafeInteger(payload?.sub) || payload.sub <= 0) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepository.findOne({
      where: { id: payload.sub, isActive: true },
    });
    if (!user) throw new UnauthorizedException();

    return { userId: user.id, email: user.email };
  }
}
