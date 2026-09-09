import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { ConfigService } from "@nestjs/config";

export interface JwtPayload {
  sub: number;
  email: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const WEAK_SECRETS = new Set([
  "changeme",
  "changeme-change-in-production",
  "change-me-in-production",
  "secret",
  "password",
  "jwt_secret",
  "your-secret-key",
  "",
]);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private refreshTokenRepository: Repository<RefreshTokenEntity>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(
    email: string,
    password: string,
    name?: string,
  ): Promise<Tokens> {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException("User with this email already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = this.userRepository.create({
      email,
      password: hashedPassword,
      name: name || email.split("@")[0],
    });

    await this.userRepository.save(user);
    return this.generateTokens(user.id, user.email);
  }

  async login(email: string, password: string): Promise<Tokens> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    return this.generateTokens(user.id, user.email);
  }

  async refresh(userId: number, refreshToken: string): Promise<Tokens> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid user");
    }

    if (!refreshToken) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const storedToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash, userId, revoked: false },
    });

    if (!storedToken) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    const isReuse = storedToken.revoked;
    if (isReuse) {
      await this.revokeAllUserTokens(userId);
      throw new UnauthorizedException("Refresh token was reused");
    }

    await this.refreshTokenRepository.update(storedToken.id, {
      revoked: true,
      revokedAt: new Date(),
      replacedBy: undefined,
    });

    return this.generateTokens(user.id, user.email);
  }

  async logout(userId: number, refreshToken: string): Promise<void> {
    if (!refreshToken) return;

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const storedToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash, userId },
    });

    if (storedToken && !storedToken.revoked) {
      await this.refreshTokenRepository.update(storedToken.id, {
        revoked: true,
        revokedAt: new Date(),
      });
    }
  }

  async revokeAllUserTokens(userId: number): Promise<void> {
    await this.refreshTokenRepository
      .createQueryBuilder()
      .update()
      .set({ revoked: true, revokedAt: new Date() })
      .where("userId = :userId AND revoked = false", { userId })
      .execute();
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User not found");

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid)
      throw new UnauthorizedException("Current password is incorrect");

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    user.password = hashedPassword;
    await this.userRepository.save(user);

    await this.revokeAllUserTokens(userId);
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserEntity | null> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || !user.isActive) return null;

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return null;

    return user;
  }

  async validateJwtSecret(): Promise<{ valid: boolean; message: string }> {
    const secret = this.configService.get("JWT_SECRET") || "";
    if (WEAK_SECRETS.has(secret.trim().toLowerCase())) {
      return {
        valid: false,
        message:
          "JWT_SECRET is weak or default. Set a strong secret in production.",
      };
    }
    if (secret.length < 32) {
      return {
        valid: false,
        message: "JWT_SECRET must be at least 32 characters.",
      };
    }
    return { valid: true, message: "JWT_SECRET is strong." };
  }

  async validateRefreshSecret(): Promise<{ valid: boolean; message: string }> {
    const secret =
      this.configService.get("JWT_REFRESH_SECRET") || "";
    if (WEAK_SECRETS.has(secret.trim().toLowerCase())) {
      return {
        valid: false,
        message:
          "JWT_REFRESH_SECRET is weak or default. Set a strong secret in production.",
      };
    }
    if (secret.length < 32) {
      return {
        valid: false,
        message:
          "JWT_REFRESH_SECRET must be at least 32 characters.",
      };
    }
    return { valid: true, message: "JWT_REFRESH_SECRET is strong." };
  }

  private async storeRefreshToken(
    userId: number,
    refreshToken: string,
  ): Promise<void> {
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const expiresIn =
      this.configService.get("JWT_REFRESH_EXPIRES_IN") || "7d";
    const expiresAt = new Date();
    const match = expiresIn.match(/(\d+)([smhd])/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      switch (unit) {
        case "s":
          expiresAt.setSeconds(expiresAt.getSeconds() + value);
          break;
        case "m":
          expiresAt.setMinutes(expiresAt.getMinutes() + value);
          break;
        case "h":
          expiresAt.setHours(expiresAt.getHours() + value);
          break;
        case "d":
          expiresAt.setDate(expiresAt.getDate() + value);
          break;
        default:
          expiresAt.setDate(expiresAt.getDate() + 7);
      }
    } else {
      expiresAt.setDate(expiresAt.getDate() + 7);
    }

    const entity = this.refreshTokenRepository.create({
      tokenHash,
      expiresAt,
      user: { id: userId } as UserEntity,
      userId,
    });
    await this.refreshTokenRepository.save(entity);
  }

  private async generateTokens(userId: number, email: string): Promise<Tokens> {
    const payload: JwtPayload = { sub: userId, email };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get("JWT_SECRET"),
      expiresIn: this.configService.get("JWT_EXPIRES_IN") || "15m",
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get("JWT_REFRESH_SECRET"),
      expiresIn: this.configService.get("JWT_REFRESH_EXPIRES_IN") || "7d",
    });

    await this.storeRefreshToken(userId, refreshToken);

    return { accessToken, refreshToken };
  }

  async verifyRefreshToken(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get("JWT_REFRESH_SECRET"),
      });
      return payload as JwtPayload;
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }
}
