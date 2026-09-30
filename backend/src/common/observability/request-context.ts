import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  errorClass?: string;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();
export const REQUEST_ID_HEADER = "X-Request-Id";
export function resolveRequestId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : randomUUID();
}
