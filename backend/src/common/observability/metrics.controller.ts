import {
  Controller,
  Get,
  Header,
  NotFoundException,
  UnauthorizedException,
  Headers,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("Cache-Control", "no-store")
  get(
    @Headers("authorization") authorization: string | undefined,
    @Res() response: Response,
  ): void {
    const token = this.config.get<string>("METRICS_TOKEN");
    if (!token) throw new NotFoundException();
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization || "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new UnauthorizedException();
    response
      .type("text/plain; version=0.0.4; charset=utf-8")
      .setHeader("Cache-Control", "no-store");
    response.send(this.metrics.render());
  }
}
