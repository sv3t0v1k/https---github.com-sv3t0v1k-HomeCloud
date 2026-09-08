import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Logger } from '@nestjs/common';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = _context.switchToHttp().getRequest();
    const { method, url } = req;
    const startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = _context.switchToHttp().getResponse();
        const status = res.statusCode;
        const responseTime = Date.now() - startTime;
        this.logger.log(`${method} ${url} ${status} ${responseTime}ms`);
      }),
    );
  }
}
