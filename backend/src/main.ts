import { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { structuredLogger } from "./common/observability/structured-logger";
import { requestObservability } from "./common/observability/request-observability";
import { MetricsService } from "./common/observability/metrics.service";
import { ConfigService } from "@nestjs/config";
import { applySecurityMiddleware } from "./common/security.config";
import { validateStartupConfiguration } from "./common/startup-validation.service";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: structuredLogger,
    bodyParser: false,
  });

  await validateStartupConfiguration(app);

  const configService = app.get(ConfigService);

  app.use(requestObservability(app.get(MetricsService)));
  applySecurityMiddleware(app, configService);
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  app.setGlobalPrefix("api/v1");

  const port = configService.get("PORT") || 3000;
  await app.listen(port);
  structuredLogger.event("info", "backend_listening", {
    context: "Bootstrap",
    port,
  });
}

bootstrap();
