import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { createDataSource, closeDataSource, buildServices } from "./services";
import { createFixtures, cleanupBenchmark, countBenchmarkRows } from "./fixtures";
import { runScale, summarize } from "./runner";

async function main(): Promise<void> {
  const config = loadConfig();
  const dataSource = await createDataSource(config.databaseUrl);

  try {
    const allResults: unknown[] = [];
    for (const scale of config.scales) {
      const services = buildServices(dataSource);
      const fixture = await createFixtures(dataSource, {
        scale,
        searchToken: "benchsearchtoken",
        tokenFraction: 0.1,
      });
      const results = await runScale(dataSource, fixture, config, services);
      allResults.push(summarize(results, fixture));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      scales: config.scales,
      runs: config.runs,
      warmupRuns: config.warmupRuns,
      results: allResults,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(config.outDir, `bench-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[bench] report written to ${outPath}`);
  } finally {
    await cleanupBenchmark(dataSource);
    const remaining = await countBenchmarkRows(dataSource);
    // eslint-disable-next-line no-console
    console.log(`[bench] remaining benchmark rows: ${JSON.stringify(remaining)}`);
    await closeDataSource(dataSource);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[bench] fatal:", err);
  process.exit(1);
});