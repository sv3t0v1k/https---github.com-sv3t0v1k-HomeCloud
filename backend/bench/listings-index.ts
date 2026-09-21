import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { createDataSource, closeDataSource, buildServices } from "./services";
import { createFixtures, cleanupBenchmark } from "./fixtures";
import { BenchConfig } from "./config";
import { median, time, ScenarioResult } from "./runner";

const LIST_TARGETS = [
  {
    name: "uploads.listUploadSessions",
    run: (s: ReturnType<typeof buildServices>, userId: number) =>
      s.uploadsService.listUploadSessions(userId),
  },
  {
    name: "sharing.listUserShares",
    run: (s: ReturnType<typeof buildServices>, userId: number) =>
      s.sharingService.listUserShares(userId),
  },
];

async function runTarget(
  services: ReturnType<typeof buildServices>,
  userId: number,
  target: { name: string; run: (s: ReturnType<typeof buildServices>, userId: number) => Promise<unknown> },
  runs: number,
  warmupRuns: number,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const rowCounts: number[] = [];

  for (let i = 0; i < warmupRuns; i++) {
    await target.run(services, userId);
  }

  for (let i = 0; i < runs; i++) {
    const { result, ms } = await time(() => target.run(services, userId));
    timings.push(ms);
    let count = 0;
    if (Array.isArray(result)) count = result.length;
    rowCounts.push(count);
  }

  return {
    name: target.name,
    scale: 0,
    runs,
    rowCounts,
    timingsMs: timings,
    medianMs: median(timings),
  };
}

async function main(): Promise<void> {
  const config: BenchConfig = loadConfig();
  const dataSource = await createDataSource(config.databaseUrl);

  try {
    const results: ScenarioResult[] = [];
    for (const scale of config.scales) {
      const services = buildServices(dataSource);
      const fixture = await createFixtures(dataSource, {
        scale,
        searchToken: "benchsearchtoken",
        tokenFraction: 0.1,
      });
      for (const target of LIST_TARGETS) {
        const r = await runTarget(
          services,
          fixture.userId,
          target,
          config.runs,
          config.warmupRuns,
        );
        r.scale = scale;
        results.push(r);
      }
      await cleanupBenchmark(dataSource, fixture.userId);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      scales: config.scales,
      runs: config.runs,
      warmupRuns: config.warmupRuns,
      results: results.map((r) => ({
        name: r.name,
        scale: r.scale,
        runs: r.runs,
        rowCounts: r.rowCounts,
        timingsMs: r.timingsMs,
        medianMs: r.medianMs,
      })),
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(config.outDir, `listings-${stamp}.json`);
    fs.mkdirSync(config.outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[bench] listings report written to ${outPath}`);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `[bench] ${r.name} scale=${r.scale} rows=${r.rowCounts[0]} median=${r.medianMs.toFixed(2)} ms`,
      );
    }
  } finally {
    await closeDataSource(dataSource);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[bench] fatal:", err);
  process.exit(1);
});