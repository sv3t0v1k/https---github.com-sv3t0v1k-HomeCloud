import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  BadRequestException,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { UploadsService } from "./uploads.service";
import {
  UploadWorkspaceResolver,
  LEGACY_UPLOAD_WORKSPACE,
} from "./upload-workspace";
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
  private readonly workspaceResolver: UploadWorkspaceResolver;
  constructor(
    private readonly storageService: StorageService,
    private readonly uploadsService: UploadsService,
  ) {
    this.workspaceResolver = new UploadWorkspaceResolver(storageService);
  }
  onModuleDestroy(): void {
    this.workspaceResolver.close();
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestEvents>();
    const response = http.getResponse<ResponseEvents>();
    const ingressRequest = request as RequestEvents & {
      user: { userId: number };
      params: { uploadId: string };
    };
    // JWT and rate admission precede this interceptor. Resolve the immutable
    // session binding before Multer creates any ingress bytes.
    const session = await this.uploadsService.getUploadSession(
      ingressRequest.user.userId,
      ingressRequest.params.uploadId,
    );
    if (session.status !== "pending" && session.status !== "uploading")
      throw new BadRequestException("Upload session is not writable");
    this.workspaceResolver.root(LEGACY_UPLOAD_WORKSPACE);
    const cleanup = () => {
      if (request.ingressWritePending) return; // Writer close owns aborted-file cleanup.
      const ingressPath = request.file?.path ?? request.ingressFilePath;
      if (!ingressPath) return;
      try {
        this.workspaceResolver.assertPath(ingressPath);
        this.storageService.assertTrustedPath(ingressPath);
        cleanupIngressFile(ingressPath, this.storageService.getTempPath(), () =>
          this.logger.warn("Failed to clean ingress file"),
          this.workspaceResolver.filesystem(),
        );
      } catch {
        this.logger.warn("Storage unavailable; ingress cleanup deferred");
      }
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
