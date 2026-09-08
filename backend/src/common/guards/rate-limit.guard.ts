import {
  Injectable,
  CanActivate,
  ExecutionContext,
  TooManyRequestsException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip || request.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 100;

    let timestamps = this.requests.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.requests.set(ip, timestamps);
    }

    while (timestamps.length && timestamps[0] < now - windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      throw new TooManyRequestsException('Too many requests');
    }

    timestamps.push(now);
    return true;
  }
}
