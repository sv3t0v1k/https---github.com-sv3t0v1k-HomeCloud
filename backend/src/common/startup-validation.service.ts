import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class StartupValidationService {
  private readonly logger = new Logger(StartupValidationService.name);

  constructor(private configService: ConfigService) {}

  async validateDatabaseCredentials(): Promise<void> {
    const dbPassword = this.configService.get<string>("DB_PASSWORD") || "";
    const redisPassword = this.configService.get<string>("REDIS_PASSWORD") || "";

    const weakCredentials = new Set([
      "changeme",
      "changeme-change-in-production",
      "change-me-in-production",
      "password",
      "postgres",
      "example",
      "",
    ]);

    const validate = (name: string, value: string): void => {
      const trimmed = value.trim().toLowerCase();
      if (weakCredentials.has(trimmed)) {
        throw new Error(
          `${name} is weak or default. Set a strong value in production.`,
        );
      }
      if (value.length < 8) {
        throw new Error(
          `${name} must be at least 8 characters. Current length: ${value.length}`,
        );
      }
    };

    validate("DB_PASSWORD", dbPassword);
    validate("REDIS_PASSWORD", redisPassword);

    this.logger.log("Database and Redis credentials validation passed.");
  }

  async validateJwtSecrets(): Promise<void> {
    const jwtSecret = this.configService.get<string>("JWT_SECRET") || "";
    const refreshSecret =
      this.configService.get<string>("JWT_REFRESH_SECRET") || "";

    const weakSecrets = new Set([
      "changeme",
      "changeme-change-in-production",
      "change-me-in-production",
      "secret",
      "password",
      "jwt_secret",
      "your-secret-key",
      "",
    ]);

    const validate = (name: string, secret: string): void => {
      const trimmed = secret.trim().toLowerCase();
      if (weakSecrets.has(trimmed)) {
        throw new Error(
          `${name} is weak or default. Set a strong secret in production.`,
        );
      }
      if (secret.length < 32) {
        throw new Error(
          `${name} must be at least 32 characters. Current length: ${secret.length}`,
        );
      }
    };

    validate("JWT_SECRET", jwtSecret);
    validate("JWT_REFRESH_SECRET", refreshSecret);

    if (jwtSecret === refreshSecret) {
      throw new Error(
        "JWT_SECRET and JWT_REFRESH_SECRET must be different values.",
      );
    }

    this.logger.log("JWT secrets validation passed.");
  }
}
