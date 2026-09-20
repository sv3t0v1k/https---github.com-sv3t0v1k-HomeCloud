import { Controller, Get } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { HttpException, HttpStatus } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

@Controller("health")
export class HealthController {
  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {}

  @Get()
  check() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async ready(): Promise<unknown> {
    const checks: Record<string, string> = {};

    let dbOk = false;
    try {
      await this.dataSource.query("SELECT 1");
      dbOk = true;
      checks.database = "ok";
    } catch {
      checks.database = "unavailable";
    }

    const storagePath =
      this.configService.get<string>("STORAGE_PATH") || "/storage";
    let storageOk = false;
    try {
      const resolved = path.resolve(storagePath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        fs.accessSync(resolved, fs.constants.W_OK);
        storageOk = true;
      }
    } catch {
      // ignore
    }
    checks.storage = storageOk ? "ok" : "unavailable";

    const allReady = dbOk && storageOk;

    if (!allReady) {
      throw new HttpException(
        { status: "not_ready", checks },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: "ready", checks };
  }
}