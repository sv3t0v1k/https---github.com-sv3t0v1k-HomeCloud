import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter";
import { LoggingInterceptor } from "../src/common/interceptors/logging.interceptor";
import { TransformInterceptor } from "../src/common/interceptors/transform.interceptor";
import { applySecurityMiddleware } from "../src/common/security.config";
import { validateStartupConfiguration } from "../src/common/startup-validation.service";
import {
  Classification,
  PreflightResult,
  STORAGE_MARKER,
  classifyStage,
  hasFullPreflightSuccess,
  runAfterFullTinySuccess,
  runHttpPreflight,
} from "./http-preflight";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не задана обязательная переменная ${name}`);
  return value;
}

function deterministicPayload(size: number): Buffer {
  const block = Buffer.from("HomeCloud isolated HTTP preflight\n", "utf8");
  const payload = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(payload, offset, 0, Math.min(block.length, size - offset));
  }
  return payload;
}

function report(tiny: PreflightResult, large: PreflightResult | undefined) {
  const multipart = classifyStage(tiny, "MULTIPART_CHUNK", [400, 422]);
  const verify = tiny.evidence.find((item) => item.stage === "VERIFY");
  const completion: Classification = verify
    ? verify.ok
      ? "HEALTHY"
      : "RISK_CONFIRMED"
    : "INCONCLUSIVE";
  const appBody = large
    ? classifyStage(large, "MULTIPART_CHUNK", [413])
    : "INCONCLUSIVE";
  return {
    probes: {
      appDirectTiny: tiny,
      appDirectOver1MiB: large,
    },
    classification: {
      MULTIPART_DTO: multipart,
      APP_DIRECT_BODY: appBody,
      BUNDLED_NGINX_BODY: "INCONCLUSIVE" as Classification,
      HTTP_COMPLETION_CORRECTNESS: completion,
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = required("HOMECLOUD_HTTP_PREFLIGHT_DATABASE_URL");
  const storagePath = required("HOMECLOUD_HTTP_PREFLIGHT_STORAGE_PATH");
  const confirm = required("HOMECLOUD_HTTP_PREFLIGHT_CONFIRM");
  const port = Number(process.env.HOMECLOUD_HTTP_PREFLIGHT_PORT ?? "30123");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Некорректный HOMECLOUD_HTTP_PREFLIGHT_PORT");
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.STORAGE_PATH = storagePath;
  process.env.PORT = String(port);
  process.env.NODE_ENV = "development";
  process.env.ALLOWED_UPLOAD_MIME_TYPES = "application/octet-stream";
  process.env.MAX_CHUNK_SIZE = String(50 * 1024 * 1024);
  process.env.MAX_FILE_SIZE = String(1024 * 1024 * 1024);
  process.env.MAX_TOTAL_SIZE = String(10 * 1024 * 1024 * 1024);
  process.env.DB_PASSWORD = required("HOMECLOUD_HTTP_PREFLIGHT_DB_PASSWORD");
  process.env.REDIS_PASSWORD = required(
    "HOMECLOUD_HTTP_PREFLIGHT_REDIS_PASSWORD",
  );
  process.env.JWT_SECRET = required("HOMECLOUD_HTTP_PREFLIGHT_JWT_SECRET");
  process.env.JWT_REFRESH_SECRET = required(
    "HOMECLOUD_HTTP_PREFLIGHT_JWT_REFRESH_SECRET",
  );

  const baseUrl =
    process.env.HOMECLOUD_HTTP_PREFLIGHT_BASE_URL?.trim() ||
    `http://127.0.0.1:${port}`;
  const common = { databaseUrl, storagePath, confirm };
  const storageEntries = fs.existsSync(storagePath)
    ? fs.readdirSync(storagePath)
    : [];
  if (storageEntries.length !== 0) {
    throw new Error("Каталог storage preflight должен быть новым и пустым");
  }
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(path.join(storagePath, STORAGE_MARKER), confirm, {
    flag: "wx",
  });
  // AppModule must be loaded only after the isolated environment is installed:
  // ConfigModule.forRoot reads process.env while the module is evaluated.
  const { AppModule } = await import("../src/app.module");
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
  });
  try {
    await validateStartupConfiguration(app);
    applySecurityMiddleware(app, app.get(ConfigService));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(
      new TransformInterceptor(),
      new LoggingInterceptor(),
    );
    app.setGlobalPrefix("api/v1");
    await app.listen(port, "127.0.0.1");
    const source = app.get(DataSource);

    const tiny = await runHttpPreflight(
      {
        ...common,
        baseUrl,
        label: "APP_DIRECT_TINY",
        payload: deterministicPayload(32 * 1024),
      },
      source,
    );
    const large = await runAfterFullTinySuccess(tiny, () =>
      runHttpPreflight(
        {
          ...common,
          baseUrl,
          label: "APP_DIRECT_OVER_1MIB",
          payload: deterministicPayload(2 * 1024 * 1024),
        },
        source,
      ),
    );

    const result = report(tiny, large);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (tiny.evidence.some((item) => item.stage === "CLEANUP" && !item.ok)) {
      throw new Error("Cleanup preflight завершился с ошибкой");
    }
    if (!hasFullPreflightSuccess(tiny)) {
      throw new Error("Tiny HTTP preflight не прошёл полный цикл");
    }
    if (!large || !hasFullPreflightSuccess(large)) {
      throw new Error("2 MiB HTTP preflight не прошёл полный цикл");
    }
    if (
      result.classification.HTTP_COMPLETION_CORRECTNESS === "RISK_CONFIRMED"
    ) {
      throw new Error("Обнаружено расхождение bytes/metadata/accounting");
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  process.stderr.write(`${JSON.stringify({ errorType: name, message })}\n`);
  process.exitCode = 1;
});
