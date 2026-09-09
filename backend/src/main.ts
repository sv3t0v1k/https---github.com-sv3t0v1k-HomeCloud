import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { StartupValidationService } from "./common/startup-validation.service";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ConfigService } from "@nestjs/config";

function buildCorsOptions(configService: ConfigService) {
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const configService = app.get(ConfigService);

  const startupValidation = app.get(StartupValidationService);
  await startupValidation.validateDatabaseCredentials();
  await startupValidation.validateJwtSecrets();

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

  app.use(cors(buildCorsOptions(configService)));

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

  app.use(
    "/api/v1",
    rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      message: { statusCode: 429, message: "Too many requests" },
    }),
  );

  app.use(
    "/api/v1/auth",
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message: { statusCode: 429, message: "Too many auth requests" },
    }),
  );

  app.setGlobalPrefix("api/v1");

  const port = configService.get("PORT") || 3000;
  await app.listen(port);
  console.log(`HomeCloud backend running on port ${port}`);
}

bootstrap();
