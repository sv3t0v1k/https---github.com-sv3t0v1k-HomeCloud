import * as fs from "fs";
import * as path from "path";
import { closeDataSource, createDataSource } from "./services";
import {
  measurePermanentDeleteScale,
  PERMANENT_DELETE_SCALES,
} from "./permanent-delete-runner";

async function main(): Promise<void> {
  const databaseUrl = process.env.HOMECLOUD_BENCH_DATABASE_URL;
  if (!databaseUrl || process.env.HOMECLOUD_BENCH_CONFIRM !== "YES")
    throw new Error(
      "Explicit isolated benchmark database and confirmation are required.",
    );
  const runs = Number(process.env.HOMECLOUD_BENCH_RUNS ?? "5");
  const warmups = Number(process.env.HOMECLOUD_BENCH_WARMUP ?? "1");
  if (
    !Number.isInteger(runs) ||
    runs < 3 ||
    !Number.isInteger(warmups) ||
    warmups < 0
  )
    throw new Error("Runs must be >=3 and warmups must be >=0.");
  const output = process.env.HOMECLOUD_BENCH_OUTPUT;
  const dataSource = await createDataSource(databaseUrl);
  const results = [];
  try {
    for (const fileCount of PERMANENT_DELETE_SCALES) {
      for (let run = 0; run < warmups + runs; run++) {
        const result = await measurePermanentDeleteScale(dataSource, fileCount);
        if (run >= warmups) results.push({ run: run - warmups + 1, ...result });
      }
    }
  } finally {
    await closeDataSource(dataSource);
  }
  const report =
    JSON.stringify(
      { head: process.env.HOMECLOUD_BENCH_HEAD, runs, warmups, results },
      null,
      2,
    ) + "\n";
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), report);
  }
  process.stdout.write(report);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
