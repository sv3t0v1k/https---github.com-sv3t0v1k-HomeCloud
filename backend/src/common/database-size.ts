import { BadRequestException } from "@nestjs/common";

/** PostgreSQL bigint/SUM boundary: reject coercion and lossy integers. */
export function parseDatabaseSize(value: unknown, message = "Invalid storage size metadata"): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\d+$/.test(value))
  ) {
    throw new BadRequestException(message);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new BadRequestException(message);
  }
  return size;
}
