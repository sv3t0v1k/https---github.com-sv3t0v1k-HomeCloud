import { LoggerService } from "@nestjs/common";
import { requestContext } from "./request-context";

const safeOperationalMessages = new Set([
  "Failed to clean ingress file",
  "Failed to clean up copied file",
  "Failed to create temp dir for session",
  "Failed to delete physical file",
  "Failed to delete temp files at",
  "Failed to generate thumbnail for file",
  "Failed to inspect stale ingress file",
  "Failed to reconcile copied file after ambiguous commit",
  "Failed to release copied file transaction",
  "Failed to roll back copied file transaction",
  "Initial expired token cleanup failed",
  "Orphaned temp dir cleanup failed",
  "Periodic cleanup failed",
  "Periodic expired token cleanup failed",
  "Startup cleanup failed",
]);

export class StructuredLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(line + "\n"),
  ) {}
  event(
    level: string,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: "homecloud-backend",
        message,
        requestId: requestContext.getStore()?.requestId,
        ...fields,
      }),
    );
  }
  private emit(level: string, message: unknown, parameters: unknown[]): void {
    // Error objects and stack arguments may contain credentials or user data.
    const context = parameters.length
      ? parameters[parameters.length - 1]
      : undefined;
    this.event(
      level,
      level === "error" || level === "warn"
        ? typeof message === "string" && safeOperationalMessages.has(message)
          ? message
          : "runtime_" + level
        : typeof message === "string"
          ? message
          : "runtime_event",
      {
        context:
          typeof context === "string" &&
          /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(context)
            ? context
            : "Application",
        ...(message instanceof Error ? { errorClass: "Error" } : {}),
      },
    );
  }
  log(message: unknown, ...parameters: unknown[]): void {
    this.emit("info", message, parameters);
  }
  error(message: unknown, ...parameters: unknown[]): void {
    this.emit("error", message, parameters);
  }
  warn(message: unknown, ...parameters: unknown[]): void {
    this.emit("warn", message, parameters);
  }
  debug(message: unknown, ...parameters: unknown[]): void {
    this.emit("debug", message, parameters);
  }
  verbose(message: unknown, ...parameters: unknown[]): void {
    this.emit("debug", message, parameters);
  }
  fatal(message: unknown, ...parameters: unknown[]): void {
    this.emit("error", message, parameters);
  }
}
export const structuredLogger = new StructuredLogger();
