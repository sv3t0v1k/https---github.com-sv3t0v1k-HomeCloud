import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { NextFunction, Request, Response } from "express";
import { isIP } from "node:net";

export function normalizeClientIp(input: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(input);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(input) === 6) {
    const [address, zone] = input.split("%");
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mappedHex = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
    if (mappedHex && !zone) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return zone ? `${normalized}%${zone}` : normalized;
  }
  return input;
}

export function clientIp(request: Request): string {
  return normalizeClientIp(
    request.ip || request.socket.remoteAddress || "unknown",
  );
}

export function trustedProxyAddress(input: unknown): string | undefined {
  if (input === undefined || input === "") return undefined;
  if (typeof input !== "string" || !isIP(input) || input.includes("%")) {
    throw new Error("TRUSTED_PROXY_IP must be one literal IP address");
  }
  return normalizeClientIp(input);
}

/** The frontend is the only trusted socket peer and emits one sanitized client IP. */
export function configureTrustedProxy(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  const trusted = trustedProxyAddress(config.get("TRUSTED_PROXY_IP"));
  const isTrusted = (address: string): boolean =>
    trusted !== undefined && normalizeClientIp(address) === trusted;
  app.set("trust proxy", isTrusted);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const forwarded = req.headers["x-forwarded-for"];
    const peerTrusted = isTrusted(req.socket.remoteAddress || "");
    if (
      !peerTrusted ||
      typeof forwarded !== "string" ||
      !isIP(forwarded) ||
      forwarded.includes("%")
    ) {
      delete req.headers["x-forwarded-for"];
      delete req.headers["x-forwarded-proto"];
      delete req.headers["x-forwarded-host"];
    } else {
      req.headers["x-forwarded-for"] = normalizeClientIp(forwarded);
      if (
        !["http", "https"].includes(String(req.headers["x-forwarded-proto"]))
      ) {
        delete req.headers["x-forwarded-proto"];
      }
    }
    // RFC 7239 is outside this deployment contract; never retain a second chain.
    delete req.headers.forwarded;
    next();
  });
}
