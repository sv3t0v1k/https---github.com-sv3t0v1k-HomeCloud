import { Test } from "@nestjs/testing";
import request from "supertest";
import { TransformInterceptor } from "../interceptors/transform.interceptor";
import { HttpExceptionFilter } from "../errors/http-exception.filter";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";

describe("operational metrics", () => {
  it("records bounded labels, cumulative duration buckets and in-flight requests", () => {
    const metrics = new MetricsService();
    metrics.start();
    expect(metrics.render()).toContain("homecloud_http_requests_in_flight 1");
    metrics.finish("GET", "/files/:id", 503, 50);
    const output = metrics.render();
    expect(output).toContain(
      'homecloud_http_requests_total{method="GET",route="/files/:id",status_class="5xx"} 1',
    );
    expect(output).toContain('le="0.05"} 1');
    expect(output).toContain("homecloud_http_requests_in_flight 0");
    expect(output).toContain("homecloud_process_resident_memory_bytes");
  });
  it("drops unsafe labels and caps total series", () => {
    const metrics = new MetricsService();
    metrics.finish("SECRET", "/secret?token=password", 999, 1);
    for (let i = 0; i < 1000; i++) metrics.finish("GET", `/route${i}`, 200, 1);
    const output = metrics.render();
    expect(output).not.toContain("password");
    expect(output).not.toContain("SECRET");
    expect(
      output.match(/^homecloud_http_requests_total/gm)?.length,
    ).toBeLessThanOrEqual(501);
  });
  it("disables endpoint without config and requires its dedicated token", () => {
    const metrics = new MetricsService();
    const response = {
      type: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      send: jest.fn(),
    } as unknown as Response;
    const disabled = new MetricsController(metrics, {
      get: () => undefined,
    } as unknown as ConfigService);
    expect(() => disabled.get(undefined, response)).toThrow(NotFoundException);
    const enabled = new MetricsController(metrics, {
      get: () => "monitor-secret",
    } as unknown as ConfigService);
    expect(() => enabled.get(undefined, response)).toThrow(
      UnauthorizedException,
    );
    expect(() => enabled.get("Bearer invalid-secret", response)).toThrow(
      UnauthorizedException,
    );
    enabled.get("Bearer monitor-secret", response);
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining("homecloud_process_uptime_seconds"),
    );
  });
  it("serves text exposition over HTTP with global interceptor and rejects unauthenticated access", async () => {
    const module = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        MetricsService,
        { provide: ConfigService, useValue: { get: () => "monitor-secret" } },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    try {
      await request(app.getHttpServer()).get("/metrics").expect(401);
      const response = await request(app.getHttpServer())
        .get("/metrics")
        .set("Authorization", "Bearer monitor-secret")
        .expect(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.text).toContain(
        "# TYPE homecloud_http_requests_total counter",
      );
      expect(response.text).not.toContain('"success"');
    } finally {
      await app.close();
    }
  });
});
