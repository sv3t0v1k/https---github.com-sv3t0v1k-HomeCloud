import { PUBLIC_UPLOAD, PublicUploadAdmission } from "./public-upload-access";
import { SSD_UPLOAD_WORKSPACE_ID } from "../entities/upload-workspace.entity";
import { SsdUploadsService, SsdIngressCapability } from "./ssd-uploads.service";
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Optional,
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
    @Optional() private readonly ssdUploads?: SsdUploadsService,
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
    const request = http.getRequest<RequestEvents & { ssdIngress?: SsdIngressCapability; ingressFinalizePending?: boolean; closeIngress?: () => void }>();
    const response = http.getResponse<ResponseEvents>();
    const ingressRequest = request as RequestEvents & {
      user?: { userId: number };
      [PUBLIC_UPLOAD]?: PublicUploadAdmission;
      params: { uploadId: string };
    };
    // JWT and rate admission precede this interceptor. Resolve the immutable
    // session binding before Multer creates any ingress bytes.
    const session = ingressRequest[PUBLIC_UPLOAD]?.session ?? await this.uploadsService.getUploadSession(
      ingressRequest.user!.userId,
      ingressRequest.params.uploadId,
    );
    if (session.status !== "pending" && session.status !== "uploading")
      throw new BadRequestException("Upload session is not writable");
    if (session.workspaceId === SSD_UPLOAD_WORKSPACE_ID) {
      if (!this.ssdUploads?.enabled) throw new BadRequestException("SSD uploads unavailable");
      request.ssdIngress = await this.ssdUploads.acquireIngress(ingressRequest.user!.userId, ingressRequest.params.uploadId);
    } else this.workspaceResolver.root(LEGACY_UPLOAD_WORKSPACE);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      if (request.ingressWritePending) { request.ingressFinalizePending = true; return; } // Writer close owns aborted-file cleanup.
      const ingressPath = request.file?.path ?? request.ingressFilePath;
      const cap = request.ssdIngress;
      cleaned = true;
      if (cap) {
        try {
          if (ingressPath) {
            cap.guard(ingressPath);
            cleanupIngressFile(ingressPath, cap.root, () => this.logger.warn("SSD ingress cleanup deferred"), cap.filesystem);
          }
        } catch { this.logger.warn("SSD ingress cleanup deferred"); }
        finally { cap.release(); }
        return;
      }
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
    request.closeIngress = cleanup;
    const disconnected = () => {
      // A response can close while the service is still hashing or committing.
      // Finalize owns release; the writer callback owns an aborted pending writer.
      request.ingressFinalizePending = true;
      if (!request.ssdIngress) cleanup();
    };
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    return next.handle().pipe(
      finalize(() => {
        request.off("aborted", disconnected);
        response.off("close", disconnected);
        cleanup();
      }),
    );
  }
}
