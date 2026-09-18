import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { ConfigService } from "@nestjs/config";
import { applySecurityMiddleware } from "./common/security.config";
import { validateStartupConfiguration } from "./common/startup-validation.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  await validateStartupConfiguration(app);

  const configService = app.get(ConfigService);

  applySecurityMiddleware(app, configService);

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

  const port = configService.get("PORT") || 3000;
  await app.listen(port);
  console.log(`HomeCloud backend running on port ${port}`);
}

bootstrap();
