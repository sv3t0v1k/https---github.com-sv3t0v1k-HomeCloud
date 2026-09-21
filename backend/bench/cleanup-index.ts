import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { createDataSource, closeDataSource } from "./services";
import { measureExpired, measureOrphanPattern } from "./cleanup-runner";
import { CleanupMeasurement, OrphanMeasurement } from "./cleanup-runner";

function fmtTiming(m: CleanupMeasurement | OrphanMeasurement): string {
  return `${m.medianMs.toFixed(2)} ms`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dataSource = await createDataSource(config.databaseUrl);

  try {
    const expiredResults: CleanupMeasurement[] = [];
    const orphanResults: OrphanMeasurement[] = [];

    for (const scale of config.scales) {
      const expired = await measureExpired(dataSource, scale, config.runs);
      expiredResults.push(expired);
      const orphan = await measureOrphanPattern(dataSource, scale, config.runs);
      orphanResults.push(orphan);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      scales: config.scales,
      runs: config.runs,
      expired: expiredResults.map((e) => ({
        scale: e.scale,
        totalSessions: e.totalSessions,
        expiredSessions: e.expiredSessions,
        activeSessions: e.activeSessions,
        cleaned: e.cleaned,
        remainingSessions: e.remainingSessions,
        timingsMs: e.timingsMs,
        medianMs: e.medianMs,
      })),
      orphan: orphanResults.map((o) => ({
        scale: o.scale,
        directories: o.directories,
        queries: o.queries,
        queriesPerDirectory: o.queriesPerDirectory,
        timingsMs: o.timingsMs,
        medianMs: o.medianMs,
      })),
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(config.outDir, `cleanup-${stamp}.json`);
    fs.mkdirSync(config.outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[bench] cleanup report written to ${outPath}`);
    for (const e of expiredResults) {
      // eslint-disable-next-line no-console
      console.log(
        `[bench] expired scale=${e.scale} cleaned=${e.cleaned}/${e.expiredSessions} median=${fmtTiming(e)}`,
      );
    }
    for (const o of orphanResults) {
      // eslint-disable-next-line no-console
      console.log(
        `[bench] orphan scale=${o.scale} dirs=${o.directories} queries=${o.queries} q/dir=${o.queriesPerDirectory.toFixed(2)} median=${fmtTiming(o)}`,
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