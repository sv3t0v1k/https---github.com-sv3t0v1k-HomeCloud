export function bearerTokenFromHeader(header: unknown): string | undefined {
  if (typeof header !== "string" || header.length > 4096) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/.exec(header);
  return match?.[1];
}
