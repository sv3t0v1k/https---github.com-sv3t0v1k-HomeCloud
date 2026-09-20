import { INestApplication } from "@nestjs/common";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ConfigService } from "@nestjs/config";
import { NextFunction, Request, Response } from "express";
import * as crypto from "crypto";

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
      "X-Share-Password",
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

/**
 * Per-token attempt limiter (verify + download): 10/min per token, shared across
 * verify and download endpoints. Keyed by SHA-256 digest — raw token never used
 * as key, stored, or logged. Same query-string-safe extraction as the metadata
 * per-token limiter. Missing token → IP fallback (fail-safe).
 */
export function getPublicSharingAttemptTokenRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 10,
    message: { statusCode: 429, message: "Too many requests for this share" },
    keyGenerator: (req: Request) => {
      const url = (req.originalUrl || req.url || "").split("?")[0];
      const match = /sharing\/public\/([^/]+)/.exec(url);
      if (match) {
        return `tok:${crypto.createHash("sha256").update(match[1]).digest("hex")}`;
      }
      return `ip:${req.ip || "unknown"}`;
    },
  };
}

/**
 * Per-token limiter: defends a single share link from multi-IP abuse.
 * Keyed by SHA-256 digest of the token segment — raw token is never used as a
 * key, stored in the rate-limit store, or logged. Malformed/missing tokens
 * fall back to IP-based key so protection is never bypassed.
 */
export function getPublicSharingTokenRateLimitOptions() {
  return {
    windowMs: 60 * 1000,
    max: 30,
    message: { statusCode: 429, message: "Too many requests for this share" },
    keyGenerator: (req: Request) => {
      const url = (req.originalUrl || req.url || "").split("?")[0];
      const match = /sharing\/public\/([^/]+)/.exec(url);
      if (match) {
        return `tok:${crypto.createHash("sha256").update(match[1]).digest("hex")}`;
      }
      return `ip:${req.ip || "unknown"}`;
    },
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
  // Per-token limiter: same IP can't exhaust one token across many IPs, and
  // many IPs can't exhaust one token. Raw token is SHA-256 digested — never
  // stored as key. Applied AFTER the IP limiter so both protections hold.
  app.use(
    "/api/v1/sharing/public",
    rateLimit(getPublicSharingTokenRateLimitOptions()),
  );
  // Children and download also verify passwords. Share one budget across all routes and
  // all tokens, including passwordless downloads, before body parsing occurs.
  app.use(
    [
      "/api/v1/sharing/public/:token/verify",
      "/api/v1/sharing/public/:token/download",
      "/api/v1/sharing/public/:token/children",
    ],
    rateLimit(getPublicSharingAttemptRateLimitOptions()),
  );
  // Per-token attempt limiter: 10/min per token across verify/download/children,
  // independent of IP. Prevents multi-IP abuse of a single share link's
  // password/quota. Applied AFTER the IP attempt limiter — both must pass.
  app.use(
    [
      "/api/v1/sharing/public/:token/verify",
      "/api/v1/sharing/public/:token/download",
      "/api/v1/sharing/public/:token/children",
    ],
    rateLimit(getPublicSharingAttemptTokenRateLimitOptions()),
  );
}
