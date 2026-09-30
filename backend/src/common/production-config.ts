import { isAbsolute } from "path";

/** Runs before database connection; errors contain names, never configuration values. */
export function validateProductionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.NODE_ENV !== "production") return config;
  const value = (name: string): string =>
    typeof config[name] === "string" ? (config[name] as string) : "";
  const reject = (name: string): never => {
    throw new Error(`Unsafe or missing production configuration: ${name}`);
  };
  const secret = (name: string, input: string, minimum: number): void => {
    if (
      input.length < minimum ||
      input !== input.trim() ||
      /chang[e-]*me|change.me.in.production|password|your.secret|example|demo|^postgres$|^secret$/i.test(
        input,
      ) ||
      new Set(input).size < 8
    )
      reject(name);
  };
  secret("JWT_SECRET", value("JWT_SECRET"), 32);
  secret("JWT_REFRESH_SECRET", value("JWT_REFRESH_SECRET"), 32);
  if (value("JWT_SECRET") === value("JWT_REFRESH_SECRET")) {
    reject("JWT_SECRET / JWT_REFRESH_SECRET");
  }
  let database!: URL;
  try {
    database = new URL(value("DATABASE_URL"));
    if (
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      !database.hostname ||
      !database.username ||
      database.pathname.length < 2
    )
      reject("DATABASE_URL");
    secret("DATABASE_URL", decodeURIComponent(database.password), 16);
  } catch {
    reject("DATABASE_URL");
  }
  if (value("DB_PASSWORD")) {
    secret("DB_PASSWORD", value("DB_PASSWORD"), 16);
    if (value("DB_PASSWORD") !== decodeURIComponent(database.password))
      reject("DB_PASSWORD / DATABASE_URL");
  }
  if (value("METRICS_TOKEN"))
    secret("METRICS_TOKEN", value("METRICS_TOKEN"), 32);
  if (
    !isAbsolute(value("STORAGE_PATH")) ||
    value("STORAGE_PATH").includes("\0")
  ) {
    reject("STORAGE_PATH");
  }
  try {
    const origin = new URL(value("FRONTEND_URL"));
    if (
      origin.protocol !== "https:" ||
      !origin.hostname ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
      reject("FRONTEND_URL");
  } catch {
    reject("FRONTEND_URL");
  }
  return config;
}
