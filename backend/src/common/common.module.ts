import { Module } from "@nestjs/common";
import { HttpExceptionFilter } from "./errors/http-exception.filter";
import { TransformInterceptor } from "./interceptors/transform.interceptor";
import { LoggingInterceptor } from "./interceptors/logging.interceptor";
import { StartupValidationService } from "./startup-validation.service";

@Module({
  providers: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    StartupValidationService,
  ],
  exports: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    StartupValidationService,
  ],
})
export class CommonModule {}
