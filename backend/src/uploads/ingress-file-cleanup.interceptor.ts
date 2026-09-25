import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { StorageService } from "../storage/storage.service";
import { cleanupIngressFile, IngressRequestState } from "./chunk-ingress";

interface RequestEvents extends IngressRequestState {
  once(event: "aborted", listener: () => void): this;
  off(event: "aborted", listener: () => void): this;
}

interface ResponseEvents {
  once(event: "close", listener: () => void): this;
  off(event: "close", listener: () => void): this;
}

@Injectable()
export class IngressFileCleanupInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IngressFileCleanupInterceptor.name);
  constructor(private readonly storageService: StorageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestEvents>();
    const response = http.getResponse<ResponseEvents>();
    const cleanup = () => {
      const ingressPath = request.file?.path ?? request.ingressFilePath;
      if (!ingressPath) return;
      cleanupIngressFile(
        ingressPath,
        this.storageService.getTempPath(),
        (error) =>
          this.logger.warn(`Failed to clean ingress file: ${error.message}`),
      );
    };
    request.once("aborted", cleanup);
    response.once("close", cleanup);
    return next.handle().pipe(
      finalize(() => {
        request.off("aborted", cleanup);
        response.off("close", cleanup);
        cleanup();
      }),
    );
  }
}
