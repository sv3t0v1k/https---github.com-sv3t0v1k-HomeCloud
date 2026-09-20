import * as fs from "fs";
import * as path from "path";

/**
 * Resolved configuration for the benchmark harness.
 *
 * All values are derived from environment variables ONLY. There is no
 * fallback to application defaults and no production database is ever
 * touched unless both explicit opt-in flags are present.
 */
export interface BenchConfig {
  databaseUrl: string;
  confirm: string;
  scales: number[];
  runs: number;
  warmupRuns: number;
  outDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Benchmark cannot start.`,
    );
  }
  return value.trim();
}

export function loadConfig(): BenchConfig {
  const databaseUrl = requireEnv("HOMECLOUD_BENCH_DATABASE_URL");
  const confirm = requireEnv("HOMECLOUD_BENCH_CONFIRM");

  if (confirm !== "YES") {
    throw new Error(
      "HOMECLOUD_BENCH_CONFIRM must be exactly YES to run benchmarks.",
    );
  }

  // Never log the raw URL — it may contain credentials.
  let host = "unparsed";
  try {
    const u = new URL(databaseUrl);
    host = `${u.hostname}:${u.port || "default"}`;
  } catch {
    // ignore — reported as-is below
  }

  // eslint-disable-next-line no-console
  console.log(`[bench] target host: ${host} (credentials withheld)`);

  const scalesRaw = process.env.HOMECLOUD_BENCH_SCALES ?? "1000";
  const scales = scalesRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

  if (scales.length === 0) {
    throw new Error("HOMECLOUD_BENCH_SCALES must contain positive integers.");
  }

  const runs = Math.max(
    1,
    Number(process.env.HOMECLOUD_BENCH_RUNS ?? "5"),
  );
  const warmupRuns = Math.max(
    0,
    Number(process.env.HOMECLOUD_BENCH_WARMUP ?? "1"),
  );

  const outDir = path.resolve(
    process.env.HOMECLOUD_BENCH_OUT_DIR ??
      path.join(__dirname, "results"),
  );
  fs.mkdirSync(outDir, { recursive: true });

  return {
    databaseUrl,
    confirm,
    scales,
    runs,
    warmupRuns,
    outDir,
  };
}