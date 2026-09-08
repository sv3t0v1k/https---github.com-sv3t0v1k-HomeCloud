import { Module } from '@nestjs/common';
import { HttpExceptionFilter } from './errors/http-exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RateLimitGuard } from './guards/rate-limit.guard';

@Module({
  providers: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    RateLimitGuard,
  ],
  exports: [
    HttpExceptionFilter,
    TransformInterceptor,
    LoggingInterceptor,
    RateLimitGuard,
  ],
})
export class CommonModule {}
