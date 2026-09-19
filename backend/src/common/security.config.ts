import { INestApplication } from "@nestjs/common";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ConfigService } from "@nestjs/config";
import { NextFunction, Request, Response } from "express";

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
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Range",
    ],
    exposedHeaders: [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Retry-After",
    ],
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

export function getPublicSharingRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 60,
    message: { statusCode: 429, message: "Too many public sharing requests" },
  };
}

export function getPublicSharingAttemptRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 10,
    message: { statusCode: 429, message: "Too many share access attempts" },
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

  // Set before CORS and every limiter so errors and preflight are also private.
  app.use(
    "/api/v1/sharing/public",
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
  );

  app.use(cors(buildCorsOptions(configService)));

  app.use("/api/v1", rateLimit(getGlobalRateLimitOptions()));

  app.use("/api/v1/auth", rateLimit(getAuthRateLimitOptions()));

  // Default IP keys and expiring in-memory stores: single-process protection.
  // Multiple replicas need a shared store; never key the store by share tokens.
  app.use(
    "/api/v1/sharing/public",
    rateLimit(getPublicSharingRateLimitOptions()),
  );
  // Download also verifies passwords. Share one budget across both routes and
  // all tokens, including passwordless downloads, before body parsing occurs.
  app.use(
    [
      "/api/v1/sharing/public/:token/verify",
      "/api/v1/sharing/public/:token/download",
    ],
    rateLimit(getPublicSharingAttemptRateLimitOptions()),
  );
}
