import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { lastValueFrom, NEVER, of, throwError } from "rxjs";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";

describe("IngressFileCleanupInterceptor", () => {
  let root: string;
  let ingress: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-ingress-cleanup-"));
    ingress = path.join(root, "multipart-ingress");
    fs.mkdirSync(ingress);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function context(filePath: string): any {
    const request = Object.assign(new EventEmitter(), {
      file: { path: filePath },
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
    const interceptor = new IngressFileCleanupInterceptor({
      getTempPath: () => root,
    } as any);
    await expect(
      lastValueFrom(
        interceptor.intercept(context(file), { handle: () => of("ok") } as any),
      ),
    ).resolves.toBe("ok");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("cleans after downstream DTO error without masking it", async () => {
    const file = path.join(ingress, "request-id");
    fs.writeFileSync(file, "data");
    const expected = new Error("dto rejected");
    const interceptor = new IngressFileCleanupInterceptor({
      getTempPath: () => root,
    } as any);
    await expect(
      lastValueFrom(
        interceptor.intercept(context(file), {
          handle: () => throwError(() => expected),
        } as any),
      ),
    ).rejects.toBe(expected);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never deletes a path outside ingress", async () => {
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "keep");
    const interceptor = new IngressFileCleanupInterceptor({
      getTempPath: () => root,
    } as any);
    await lastValueFrom(
      interceptor.intercept(context(outside), {
        handle: () => of("ok"),
      } as any),
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("cleans a request-owned file when the socket aborts before Multer completes", () => {
    const file = path.join(ingress, "request-id");
    fs.writeFileSync(file, "partial");
    const ctx = context(file);
    delete ctx.request.file;
    ctx.request.ingressFilePath = file;
    const interceptor = new IngressFileCleanupInterceptor({
      getTempPath: () => root,
    } as any);

    interceptor.intercept(ctx, { handle: () => NEVER } as any);
    ctx.request.emit("aborted");

    expect(fs.existsSync(file)).toBe(false);
  });
});
