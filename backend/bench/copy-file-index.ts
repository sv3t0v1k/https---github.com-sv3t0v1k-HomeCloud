import * as fs from "fs";
import * as path from "path";
import { createDataSource, closeDataSource } from "./services";
import { COPY_FILE_SCALES, measureCopyFileScale } from "./copy-file-runner";

async function main(): Promise<void> {
  const databaseUrl = process.env.HOMECLOUD_BENCH_DATABASE_URL;
  if (!databaseUrl || process.env.HOMECLOUD_BENCH_CONFIRM !== "YES") {
    throw new Error(
      "HOMECLOUD_BENCH_DATABASE_URL and HOMECLOUD_BENCH_CONFIRM=YES are required.",
    );
  }
  const runs = Number(process.env.HOMECLOUD_BENCH_RUNS ?? "5");
  const warmups = Number(process.env.HOMECLOUD_BENCH_WARMUP ?? "1");
  if (
    !Number.isInteger(runs) ||
    runs < 3 ||
    !Number.isInteger(warmups) ||
    warmups < 0
  ) {
    throw new Error("Runs must be >=3 and warmups must be >=0.");
  }
  const output = process.env.HOMECLOUD_BENCH_OUTPUT;
  const dataSource = await createDataSource(databaseUrl);
  const results = [];
  try {
    for (const scaleBytes of COPY_FILE_SCALES) {
      for (let run = 0; run < warmups + runs; run++) {
        const result = await measureCopyFileScale(dataSource, scaleBytes);
        if (run >= warmups) results.push({ run: run - warmups + 1, ...result });
      }
    }
  } finally {
    await closeDataSource(dataSource);
  }
  const report = JSON.stringify(
    { head: process.env.HOMECLOUD_BENCH_HEAD, runs, warmups, results },
    null,
    2,
  );
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), report + "\n");
  }
  process.stdout.write(report + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
