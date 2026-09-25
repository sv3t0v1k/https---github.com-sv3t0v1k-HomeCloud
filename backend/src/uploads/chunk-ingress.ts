import { BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

export const DEFAULT_MAX_CHUNK_SIZE = 50 * 1024 * 1024;

export function parseMaxChunkSize(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_CHUNK_SIZE;
  const value = String(raw).trim();
  const size = Number(value);
  if (
    value === "" ||
    !Number.isFinite(size) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new BadRequestException(
      `MAX_CHUNK_SIZE must be a positive safe integer, got "${value}"`,
    );
  }
  return size;
}

export function getMulterFileSizeLimit(raw: unknown): number {
  const maxChunkSize = parseMaxChunkSize(raw);
  if (maxChunkSize === Number.MAX_SAFE_INTEGER) {
    throw new BadRequestException(
      "MAX_CHUNK_SIZE is too large for the multipart transport limit",
    );
  }
  // Busboy emits LIMIT_FILE_SIZE as soon as the configured byte count is
  // reached. Keep the production maximum inclusive while rejecting N + 1.
  return maxChunkSize + 1;
}

export interface IngressChunkFile {
  path: string;
  size: number;
}

export interface IngressRequestState {
  ingressFilePath?: string;
  file?: { path?: string };
}

interface FileSystemError extends Error {
  code?: string;
}

export function getIngressRoot(tempRoot: string): string {
  return path.resolve(tempRoot, "multipart-ingress");
}

export function cleanupIngressFile(
  filePath: string | undefined,
  tempRoot: string,
  onError?: (error: FileSystemError) => void,
): boolean {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== getIngressRoot(tempRoot)) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (error) {
    const fsError = error as FileSystemError;
    if (fsError.code === "ENOENT") return true;
    onError?.(fsError);
    return false;
  }
}
