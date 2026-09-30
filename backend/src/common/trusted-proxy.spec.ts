import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Request, Response, NextFunction } from "express";
import request from "supertest";
import {
  configureTrustedProxy,
  clientIp,
  trustedProxyAddress,
  normalizeClientIp,
} from "./trusted-proxy";
import { applySecurityMiddleware } from "./security.config";
import { requestObservability } from "./observability/request-observability";
import { StructuredLogger } from "./observability/structured-logger";

describe("trusted frontend proxy", () => {
  let app: NestExpressApplication;
  let peer: string;
  beforeEach(async () => {
    peer = "192.0.2.9";
    app = (
      await Test.createTestingModule({}).compile()
    ).createNestApplication<NestExpressApplication>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: peer,
        configurable: true,
      });
      next();
    });
    const config = new ConfigService({
      NODE_ENV: "test",
      TRUSTED_PROXY_IP: "172.30.0.10",
    });
    configureTrustedProxy(app, config);
    app.use(
      requestObservability(undefined, {
        event: jest.fn(),
      } as unknown as StructuredLogger),
    );
    applySecurityMiddleware(app, config);
    app
      .getHttpAdapter()
      .getInstance()
      .get("/api/v1/auth/probe", (req: Request, res: Response) =>
        res.json({
          ip: clientIp(req),
          protocol: req.protocol,
          hostname: req.hostname,
        }),
      );
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  const probe = () => request(app.getHttpServer()).get("/api/v1/auth/probe");
  it("uses socket identity and ignores untrusted forwarded headers", async () => {
    expect((await probe()).body).toMatchObject({ ip: peer, protocol: "http" });
    const result = await probe()
      .set("X-Forwarded-For", "203.0.113.7")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "evil.example");
    expect(result.body).toMatchObject({
      ip: peer,
      protocol: "http",
      hostname: "127.0.0.1",
    });
    expect(result.headers["strict-transport-security"]).toBeUndefined();
  });
  it("accepts sanitized trusted proxy data, mapped IPv4 and request IDs", async () => {
    peer = "::ffff:172.30.0.10";
    const result = await probe()
      .set("X-Forwarded-For", "::ffff:203.0.113.7")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "cloud.example")
      .set("X-Request-Id", "proxy-correlation-123");
    expect(result.body).toEqual({
      ip: "203.0.113.7",
      protocol: "https",
      hostname: "cloud.example",
    });
    expect(result.headers["x-request-id"]).toBe("proxy-correlation-123");
  });
  it.each([
    "unknown",
    "203.0.113.1, 203.0.113.2",
    "203.0.113.1:123",
    "",
    "203.0.113.999",
    "fe80::1%lo0",
  ])("fails closed for invalid single-hop header %s", async (header) => {
    peer = "172.30.0.10";
    const result = await probe()
      .set("X-Forwarded-For", header)
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "evil.example");
    expect(result.body).toMatchObject({
      ip: peer,
      protocol: "http",
      hostname: "127.0.0.1",
    });
  });
  it("canonicalizes IPv6 and ignores invalid protocol", async () => {
    peer = "172.30.0.10";
    const result = await probe()
      .set("X-Forwarded-For", "2001:0db8:0:0:0:0:0:1")
      .set("X-Forwarded-Proto", "https,http");
    expect(result.body).toMatchObject({ ip: "2001:db8::1", protocol: "http" });
  });
  it("separates trusted client budgets and merges mapped IPv4", async () => {
    peer = "172.30.0.10";
    for (let i = 0; i < 10; i++)
      await probe().set("X-Forwarded-For", "203.0.113.7").expect(200);
    await probe().set("X-Forwarded-For", "::ffff:203.0.113.7").expect(429);
    const independent = await probe().set("X-Forwarded-For", "203.0.113.8");
    expect(independent.status).toBe(200);
  });
  it("prevents untrusted header rotation bypassing auth limits", async () => {
    for (let i = 0; i < 10; i++)
      await probe()
        .set("X-Forwarded-For", `203.0.113.${i + 1}`)
        .expect(200);
    const blocked = await probe().set("X-Forwarded-For", "203.0.113.99");
    expect(blocked.status).toBe(429);
  });
  it("defaults to no trust and rejects broad configuration", () => {
    expect(trustedProxyAddress(undefined)).toBeUndefined();
    for (const value of [
      true,
      "true",
      "1",
      "172.30.0.0/24",
      "loopback",
      " 172.30.0.10",
    ])
      expect(() => trustedProxyAddress(value)).toThrow("TRUSTED_PROXY_IP");
    expect(normalizeClientIp("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(normalizeClientIp("fe80:0::1%lo0")).toBe("fe80::1%lo0");
    expect(() => trustedProxyAddress("fe80::1%lo0")).toThrow();
    expect(trustedProxyAddress("2001:db8::1")).toBe("2001:db8::1");
  });
});
