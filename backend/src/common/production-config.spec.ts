import { validateProductionConfig } from "./production-config";

const valid = () => ({
  NODE_ENV: "production",
  JWT_SECRET: "access-A7s9K2v6P4n8Q1r5T3u0W9x2Y6z8",
  JWT_REFRESH_SECRET: "refresh-B8t0L3w7Q5o9R2s6U4v1X0y3Z7a9",
  DATABASE_URL:
    "postgresql://homecloud:D4b7N9p2R6s8T1u5@postgres:5432/homecloud",
  STORAGE_PATH: "/storage",
  FRONTEND_URL: "https://cloud.example.org",
});

describe("production configuration before dependency initialization", () => {
  it("accepts explicit production configuration with disabled metrics", () => {
    const config = valid();
    expect(validateProductionConfig(config)).toBe(config);
  });
  it("preserves development and test configuration", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      const config = { NODE_ENV };
      expect(validateProductionConfig(config)).toBe(config);
    }
  });
  it.each([
    "JWT_SECRET",
    "JWT_REFRESH_SECRET",
    "DATABASE_URL",
    "STORAGE_PATH",
    "FRONTEND_URL",
  ])("rejects missing %s", (name) => {
    expect(() => validateProductionConfig({ ...valid(), [name]: "" })).toThrow(
      name,
    );
  });
  it.each([
    ["JWT_SECRET", "change-me-in-production"],
    ["JWT_SECRET", "a".repeat(40)],
    ["JWT_SECRET", "abcdefgh".repeat(4)],
    ["JWT_SECRET", "0123456789".repeat(4)],
    ["JWT_SECRET", "abcdefghijklmnopqrstuvwxyz123456"],
    ["JWT_SECRET", "replace-me-with-a-secure-random-secret"],
    ["JWT_SECRET", "placeholder-A7s9K2v6P4n8Q1r5T3u0W9x2"],
    ["JWT_SECRET", "default-A7s9K2v6P4n8Q1r5T3u0W9x2Y6"],
    ["JWT_REFRESH_SECRET", "short"],
    ["DATABASE_URL", "postgresql://homecloud:password@postgres/homecloud"],
    ["DATABASE_URL", "postgresql://postgres/homecloud"],
    ["DATABASE_URL", "https://user:strong@postgres/homecloud"],
    ["DATABASE_URL", "postgresql://homecloud:%ZZ@postgres/homecloud"],
    ["DB_PASSWORD", "example"],
    ["METRICS_TOKEN", "weak"],
    ["METRICS_TOKEN", "   "],
    ["REDIS_PASSWORD", "weak"],
    ["REDIS_PASSWORD", "   "],
    ["DB_PASSWORD", "   "],
    ["STORAGE_PATH", "./storage"],
    ["FRONTEND_URL", "http://cloud.example.org"],
    ["FRONTEND_URL", "https://cloud.example.org/path"],
    ["FRONTEND_URL", "https://user:pass@cloud.example.org"],
    ["FRONTEND_URL", "https://localhost"],
  ])("rejects unsafe %s without leaking its value", (name, unsafe) => {
    let message = "Accepted unsafe configuration";
    try {
      validateProductionConfig({ ...valid(), [name]: unsafe });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`Unsafe or missing production configuration: ${name}`);
    expect(message).not.toContain(unsafe);
  });
  it("rejects identical access and refresh secrets", () => {
    expect(() =>
      validateProductionConfig({
        ...valid(),
        JWT_REFRESH_SECRET: valid().JWT_SECRET,
      }),
    ).toThrow("JWT_SECRET / JWT_REFRESH_SECRET");
  });
  it("accepts configured strong metrics token", () => {
    expect(() =>
      validateProductionConfig({
        ...valid(),
        METRICS_TOKEN: "metrics-C9u1M4x8R6p0S3t7V5w2Y1z4A8b0",
      }),
    ).not.toThrow();
  });
  it.each(["METRICS_TOKEN", "REDIS_PASSWORD", "DB_PASSWORD"])(
    "rejects non-string configured %s without serializing it",
    (name) => {
      expect(() =>
        validateProductionConfig({
          ...valid(),
          [name]: { sensitive: "hidden" },
        }),
      ).toThrow(`Unsafe or missing production configuration: ${name}`);
    },
  );
  it("accepts absent or empty optional credentials", () => {
    expect(() =>
      validateProductionConfig({
        ...valid(),
        METRICS_TOKEN: "",
        REDIS_PASSWORD: "",
        DB_PASSWORD: "",
      }),
    ).not.toThrow();
  });
  it("accepts a matching database password and a strong optional Redis password", () => {
    expect(() =>
      validateProductionConfig({
        ...valid(),
        DB_PASSWORD: "D4b7N9p2R6s8T1u5",
        REDIS_PASSWORD: "J6c9R2t5V8n1B4m7",
      }),
    ).not.toThrow();
  });
  it("rejects mismatched database credentials without exposing either value", () => {
    expect(() =>
      validateProductionConfig({ ...valid(), DB_PASSWORD: "J6c9R2t5V8n1B4m7" }),
    ).toThrow(
      "Unsafe or missing production configuration: DB_PASSWORD / DATABASE_URL",
    );
  });
});
