import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { lastValueFrom, NEVER, of, throwError } from "rxjs";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";

describe("IngressFileCleanupInterceptor", () => {
  let root: string;
  let ingress: string;
  let interceptors: IngressFileCleanupInterceptor[];

  beforeEach(() => {
    interceptors = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-ingress-cleanup-"));
    ingress = path.join(root, "multipart-ingress");
    fs.mkdirSync(ingress);
  });

  afterEach(() => {
    for (const interceptor of interceptors) interceptor.onModuleDestroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeInterceptor(uploads = { getUploadSession: jest.fn().mockResolvedValue({ status: "pending" }) }) {
    const interceptor = new IngressFileCleanupInterceptor({
      assertTemporaryPath: jest.fn((target: string) => target),
      assertTrustedPath: jest.fn((target: string) => target),
      getTempPath: () => root,
    } as any, uploads as any);
    interceptors.push(interceptor);
    return interceptor;
  }

  function context(filePath: string): any {
    const request = Object.assign(new EventEmitter(), {
      file: { path: filePath },
      user: { userId: 1 },
      params: { uploadId: "11111111-1111-4111-8111-111111111111" },
    });
    const response = new EventEmitter();
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      request,
      response,
    };
  }

  it("cleans after success and preserves the response", async () => {
    const file = path.join(ingress, "request-id");
    fs.writeFileSync(file, "data");
    const interceptor = makeInterceptor();
    await expect(
      lastValueFrom(
        await interceptor.intercept(context(file), { handle: () => of("ok") } as any),
      ),
    ).resolves.toBe("ok");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("cleans after downstream DTO error without masking it", async () => {
    const file = path.join(ingress, "request-id");
    fs.writeFileSync(file, "data");
    const expected = new Error("dto rejected");
    const interceptor = makeInterceptor();
    await expect(
      lastValueFrom(
        await interceptor.intercept(context(file), {
          handle: () => throwError(() => expected),
        } as any),
      ),
    ).rejects.toBe(expected);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never deletes a path outside ingress", async () => {
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "keep");
    const interceptor = makeInterceptor();
    await lastValueFrom(
      await interceptor.intercept(context(outside), {
        handle: () => of("ok"),
      } as any),
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("cleans a request-owned file when the socket aborts before Multer completes", async () => {
    const file = path.join(ingress, "request-id");
    fs.writeFileSync(file, "partial");
    const ctx = context(file);
    delete ctx.request.file;
    ctx.request.ingressFilePath = file;
    const interceptor = makeInterceptor();

    await interceptor.intercept(ctx, { handle: () => NEVER } as any);
    ctx.request.emit("aborted");

    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects an unavailable bound workspace before downstream ingress writes", async () => {
    const failure = new Error("Upload workspace unavailable");
    const getUploadSession = jest.fn().mockRejectedValue(failure);
    const interceptor = makeInterceptor({ getUploadSession });
    const handle = jest.fn(() => {
      fs.writeFileSync(path.join(ingress, "unexpected"), "bytes");
      return of("ok");
    });
    const ctx = context(path.join(ingress, "request-id"));
    await expect(interceptor.intercept(ctx, { handle } as any)).rejects.toBe(failure);
    expect(getUploadSession).toHaveBeenCalledWith(1, ctx.request.params.uploadId);
    expect(handle).not.toHaveBeenCalled();
    expect(fs.readdirSync(ingress)).toEqual([]);
    expect(ctx.request.listenerCount("aborted")).toBe(0);
  });

});
