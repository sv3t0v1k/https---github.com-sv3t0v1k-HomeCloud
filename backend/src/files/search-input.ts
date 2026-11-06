import { BadRequestException } from "@nestjs/common";

export function searchQuery(value: unknown, minimum = 2): string {
  if (typeof value !== "string") throw new BadRequestException("Invalid search query");
  const query = value.trim();
  if (query.length < minimum || query.length > 100 || [...query].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new BadRequestException("Invalid search query");
  }
  return query;
}

export function searchPageNumber(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new BadRequestException("Invalid search pagination");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum || number < minimum) {
    throw new BadRequestException("Invalid search pagination");
  }
  return number;
}
