import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";

export const UPLOAD_RATE_POLICY = {
  chunk: { rate: 25, burst: 50 },
  abort: { rate: 0.5, burst: 10 },
  admission: { rate: 100, burst: 100 },
  admissionAbort: { rate: 10, burst: 20 },
  maxPerUserConcurrent: 4,
  maxConcurrent: 32,
  maxKeys: 10000,
  idleMs: 300000,
} as const;
export type UploadRequestKind = "chunk" | "abort";
interface Bucket {
  tokens: number;
  refillAt: number;
  seenAt: number;
  active: number;
}
type Policy = { rate: number; burst: number };
export class UploadThrottleException extends HttpException {
  constructor(readonly retryAfter: number) {
    super("Too many upload requests; retry later", 429);
  }
}

/** One bounded state per user, never per session/token. Active work is not evicted. */
@Injectable()
export class UploadRateLimitService {
  private readonly chunk = new Map<string, Bucket>();
  private readonly abort = new Map<string, Bucket>();
  private readonly admission = new Map<string, Bucket>();
  private readonly admissionAbort = new Map<string, Bucket>();
  private lastSweep = 0;
  private active = 0;
  now(): number {
    return Date.now();
  }
  private take(
    store: Map<string, Bucket>,
    key: string,
    policy: Policy,
  ): Bucket {
    const now = this.now();
    if (now - this.lastSweep >= 1000) {
      for (const map of [
        this.chunk,
        this.abort,
        this.admission,
        this.admissionAbort,
      ]) {
        for (const [id, entry] of map) {
          if (
            entry.active === 0 &&
            now - entry.seenAt >= UPLOAD_RATE_POLICY.idleMs
          )
            map.delete(id);
        }
      }
      this.lastSweep = now;
    }
    let entry = store.get(key);
    if (!entry) {
      if (store.size >= UPLOAD_RATE_POLICY.maxKeys)
        throw new UploadThrottleException(60);
      entry = { tokens: policy.burst, refillAt: now, seenAt: now, active: 0 };
      store.set(key, entry);
    }
    const elapsed = Math.max(0, now - entry.refillAt);
    entry.tokens = Math.min(
      policy.burst,
      entry.tokens + (elapsed * policy.rate) / 1000,
    );
    entry.refillAt = Math.max(now, entry.refillAt);
    entry.seenAt = Math.max(now, entry.seenAt);
    if (entry.tokens < 1)
      throw new UploadThrottleException(
        Math.max(1, Math.ceil((1 - entry.tokens) / policy.rate)),
      );
    entry.tokens -= 1;
    return entry;
  }
  admitIp(ip: string, kind: UploadRequestKind): void {
    this.take(
      kind === "chunk" ? this.admission : this.admissionAbort,
      ip,
      kind === "chunk"
        ? UPLOAD_RATE_POLICY.admission
        : UPLOAD_RATE_POLICY.admissionAbort,
    );
  }
  enter(userId: number, kind: UploadRequestKind): () => void {
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new UnauthorizedException();
    const bucket = this.take(
      kind === "chunk" ? this.chunk : this.abort,
      String(userId),
      UPLOAD_RATE_POLICY[kind],
    );
    if (kind === "abort") return () => undefined;
    if (
      bucket.active >= UPLOAD_RATE_POLICY.maxPerUserConcurrent ||
      this.active >= UPLOAD_RATE_POLICY.maxConcurrent
    )
      throw new UploadThrottleException(1);
    bucket.active++;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.active--;
      this.active--;
      bucket.seenAt = Math.max(bucket.seenAt, this.now());
    };
  }
  counts() {
    return {
      active: this.active,
      chunkKeys: this.chunk.size,
      abortKeys: this.abort.size,
      admissionKeys: this.admission.size,
      admissionAbortKeys: this.admissionAbort.size,
    };
  }
}

const VERIFIED_TRANSFER = Symbol("verified-transfer");
const TRANSFER_LEASE = Symbol("upload-transfer-lease");
type Lease = {
  phase: "ingress" | "processing";
  released: boolean;
  release: () => void;
};
type UploadRequest = Request & {
  [VERIFIED_TRANSFER]?: number;
  [TRANSFER_LEASE]?: Lease;
  user?: { userId: number };
};

/** Only these exact, normally generated routes can bypass the ordinary API bucket. */
export function uploadRequestKind(
  request: Request,
): UploadRequestKind | undefined {
  const base =
    "/api/v1/uploads/session/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (
    request.method === "POST" &&
    new RegExp(`^${base}/chunk/?$`, "i").test(request.path)
  )
    return "chunk";
  if (
    request.method === "DELETE" &&
    new RegExp(`^${base}/?$`, "i").test(request.path)
  )
    return "abort";
  return undefined;
}
export function markVerifiedTransfer(request: Request, userId: number): void {
  (request as UploadRequest)[VERIFIED_TRANSFER] = userId;
}
export function hasVerifiedTransfer(request: Request): boolean {
  return (request as UploadRequest)[VERIFIED_TRANSFER] !== undefined;
}

export function markUploadProcessing(request: Request): void {
  const lease = (request as UploadRequest)[TRANSFER_LEASE];
  if (request.aborted || !lease || lease.released)
    throw new BadRequestException("Upload request cancelled");
  lease.phase = "processing";
}

/** Post-JWT, before multipart. Disconnected handlers keep their lease until settled. */
@Injectable()
export class UploadRateLimitInterceptor implements NestInterceptor {
  constructor(private readonly limits: UploadRateLimitService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<UploadRequest>();
    const response = http.getResponse<Response>();
    const kind: UploadRequestKind =
      request.method === "DELETE" ? "abort" : "chunk";
    let release: () => void;
    try {
      release = this.limits.enter(request.user?.userId ?? 0, kind);
    } catch (error) {
      if (error instanceof UploadThrottleException)
        response.setHeader("Retry-After", String(error.retryAfter));
      throw error;
    }
    const lease: Lease = {
      phase: "ingress",
      released: false,
      release: () => {
        if (lease.released) return;
        lease.released = true;
        release();
      },
    };
    request[TRANSFER_LEASE] = lease;
    const disconnected = () => {
      if (lease.phase === "ingress") lease.release();
    };
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    const cleanup = () => {
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      lease.release();
    };
    try {
      return next.handle().pipe(finalize(cleanup));
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
