import { NextFunction, Request, Response } from "express";
import { performance } from "node:perf_hooks";
import {
  REQUEST_ID_HEADER,
  requestContext,
  resolveRequestId,
} from "./request-context";
import { StructuredLogger, structuredLogger } from "./structured-logger";

export interface RequestObserver {
  start(): void;
  finish(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ): void;
}
export function requestRoute(request: Request): string {
  const path: unknown = request.route?.path;
  return typeof path === "string" &&
    path.length <= 200 &&
    /^\/[A-Za-z0-9_/:.-]*$/.test(path)
    ? path
    : "unmatched";
}
export function requestObservability(
  observer?: RequestObserver,
  logger: StructuredLogger = structuredLogger,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const context = {
      requestId: resolveRequestId(request.headers["x-request-id"]),
    };
    requestContext.run(context, () => {
      response.setHeader(REQUEST_ID_HEADER, context.requestId);
      const start = performance.now();
      observer?.start();
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        requestContext.run(context, () => {
          const method = [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "HEAD",
            "OPTIONS",
          ].includes(request.method)
            ? request.method
            : "OTHER";
          const statusCode = response.writableFinished
            ? response.statusCode
            : 499;
          const durationMs =
            Math.round((performance.now() - start) * 1000) / 1000;
          const route = requestRoute(request);
          logger.event(
            statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
            "http_request_completed",
            {
              context: "HTTP",
              method,
              route,
              statusCode,
              durationMs,
              errorClass: requestContext.getStore()?.errorClass,
            },
          );
          observer?.finish(method, route, statusCode, durationMs);
        });
      };
      response.once("finish", finish);
      response.once("close", finish);
      next();
    });
  };
}
