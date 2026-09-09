import { Module } from "@nestjs/common";
import { HttpExceptionFilter } from "./errors/http-exception.filter";
import { TransformInterceptor } from "./interceptors/transform.interceptor";
import { LoggingInterceptor } from "./interceptors/logging.interceptor";
import { RateLimitGuard } from "./guards/rate-limit.guard";
import { StartupValidationService } from "./startup-validation.service";

@Module({
  providers: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    RateLimitGuard,
    StartupValidationService,
  ],
  exports: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    RateLimitGuard,
    StartupValidationService,
  ],
})
export class CommonModule {}
