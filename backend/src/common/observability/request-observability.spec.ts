import express from "express";
import { ArgumentsHost, ServiceUnavailableException } from "@nestjs/common";
import { HttpExceptionFilter } from "../errors/http-exception.filter";
import request from "supertest";
import { requestContext, resolveRequestId } from "./request-context";
import { requestObservability } from "./request-observability";
import { StructuredLogger } from "./structured-logger";

describe("request observability", () => {
  it("accepts only conservative bounded IDs", () => {
    expect(resolveRequestId("abc_123-XYZ")).toBe("abc_123-XYZ");
    for (const id of [
      undefined,
      ["one", "two"],
      "x".repeat(65),
      "abc\nsecret",
      "token=secret",
      "",
    ]) {
      expect(resolveRequestId(id)).toMatch(/^[a-f0-9-]{36}$/);
    }
  });
  it("isolates async concurrent contexts and logs templates without secrets", async () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    const observer = { start: jest.fn(), finish: jest.fn() };
    const app = express();
    app.use(requestObservability(observer, logger));
    app.get("/sharing/:token", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
      logger.log("async_work", "Test");
      res.json({ id: requestContext.getStore()?.requestId });
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .get("/sharing/private-share-token?password=private-password")
          .set("Authorization", "Bearer private-access-token")
          .set("Cookie", "secret=private-cookie")
          .set("X-Request-Id", `request-${i}`),
      ),
    );
    results.forEach((result, i) => {
      expect(result.body.id).toBe(`request-${i}`);
      expect(result.headers["x-request-id"]).toBe(`request-${i}`);
    });
    expect(observer.start).toHaveBeenCalledTimes(10);
    expect(observer.finish).toHaveBeenCalledTimes(10);
    const completions = lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.message === "http_request_completed");
    expect(completions).toHaveLength(10);
    completions.forEach((line) =>
      expect(line).toMatchObject({
        level: "info",
        service: "homecloud-backend",
        route: "/sharing/:token",
        method: "GET",
        statusCode: 200,
        durationMs: expect.any(Number),
        timestamp: expect.any(String),
        requestId: expect.stringMatching(/^request-/),
      }),
    );
    expect(lines.join()).not.toMatch(
      /private-share-token|private-password|private-access-token|private-cookie/,
    );
  });
  it("covers early rejection and assigns a generated response ID", async () => {
    const lines: string[] = [];
    const app = express();
    app.use(
      requestObservability(
        undefined,
        new StructuredLogger((line) => lines.push(line)),
      ),
    );
    app.use((_req, res) => {
      res.status(429).end();
    });
    const result = await request(app).get(
      "/unknown/private-token?secret=private",
    );
    expect(result.headers["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "warn",
      route: "unmatched",
      statusCode: 429,
    });
    expect(lines[0]).not.toContain("private");
  });
  it("records server failure severity with correlation and rejects unsafe header", async () => {
    const lines: string[] = [];
    const app = express();
    app.use(
      requestObservability(
        undefined,
        new StructuredLogger((line) => lines.push(line)),
      ),
    );
    app.get("/failure", (_req, res) => {
      const context = requestContext.getStore();
      if (context) context.errorClass = "Error";
      res.status(500).end();
    });
    const result = await request(app)
      .get("/failure")
      .set("X-Request-Id", "token=private-secret");
    expect(result.headers["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error",
      statusCode: 500,
      errorClass: "Error",
      requestId: result.headers["x-request-id"],
    });
    expect(lines[0]).not.toContain("private-secret");
  });
  it("marks internal failures without logging exception secrets and preserves safe dependency details", () => {
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnValue({ json }) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: "/health/ready" }),
      }),
    } as unknown as ArgumentsHost;
    requestContext.run({ requestId: "failure-request" }, () => {
      new HttpExceptionFilter().catch(
        new ServiceUnavailableException({
          message: "Not ready",
          checks: {
            database: "unavailable",
            storage: "ok",
            password: "private-secret",
          },
          secret: "private-secret",
        }),
        host,
      );
      expect(requestContext.getStore()?.errorClass).toBe(
        "ServiceUnavailableException",
      );
      expect(json.mock.calls[0][0]).toMatchObject({
        statusCode: 503,
        checks: { database: "unavailable", storage: "ok" },
      });
      expect(JSON.stringify(json.mock.calls)).not.toContain("private-secret");
      new HttpExceptionFilter().catch(new Error("private-secret"), host);
      expect(requestContext.getStore()?.errorClass).toBe("Error");
      expect(json.mock.calls[1][0].message).toBe("Internal server error");
    });
  });
  it("omits arbitrary errors/stacks from runtime logs", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    logger.error(
      "password=private-password",
      "stack with private-token",
      "Database",
    );
    logger.error(new Error("private-password"));
    logger.error("Failed to delete physical file", "FilesService");
    expect(lines.join()).not.toMatch(/private-password|private-token/);
    expect(JSON.parse(lines[2]).message).toBe("Failed to delete physical file");
    expect(JSON.parse(lines[0])).toMatchObject({
      message: "runtime_error",
      context: "Database",
      level: "error",
    });
  });
});
