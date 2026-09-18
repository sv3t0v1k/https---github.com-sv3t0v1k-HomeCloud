import { INestApplication } from "@nestjs/common";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ConfigService } from "@nestjs/config";

export function buildCorsOptions(configService: ConfigService) {
  const frontendUrl = configService.get("FRONTEND_URL");
  const isProduction = configService.get("NODE_ENV") === "production";

  if (isProduction && !frontendUrl) {
    throw new Error(
      "FRONTEND_URL must be set in production for CORS configuration",
    );
  }

  const origin = isProduction
    ? frontendUrl
    : frontendUrl || ["http://localhost:5173", "http://127.0.0.1:5173"];

  return {
    origin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  };
}

export function getGlobalRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 100,
    message: { statusCode: 429, message: "Too many requests" },
  };
}

export function getAuthRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 10,
    message: { statusCode: 429, message: "Too many auth requests" },
  };
}

export function applySecurityMiddleware(
  app: INestApplication,
  configService: ConfigService,
): void {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  app.use(cors(buildCorsOptions(configService)));

  app.use("/api/v1", rateLimit(getGlobalRateLimitOptions()));

  app.use("/api/v1/auth", rateLimit(getAuthRateLimitOptions()));
}
