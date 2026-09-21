import { DataSource } from "typeorm";
import { BenchServices, buildServices } from "./services";
import { createFixtures, cleanupBenchmark, FixtureResult } from "./fixtures";
import { BenchConfig } from "./config";

export interface ScenarioResult {
  name: string;
  scale: number;
  runs: number;
  rowCounts: number[];
  timingsMs: number[];
  medianMs: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return { result, ms: Number(end - start) / 1e6 };
}

export interface TargetRun {
  name: string;
  run: (services: BenchServices, userId: number, fixture: FixtureResult) => Promise<unknown>;
}

async function runTarget(
  services: BenchServices,
  userId: number,
  fixture: FixtureResult,
  target: TargetRun,
  runs: number,
  warmupRuns: number,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const rowCounts: number[] = [];

  for (let i = 0; i < warmupRuns; i++) {
    await target.run(services, userId, fixture);
  }

  for (let i = 0; i < runs; i++) {
    const { result, ms } = await time(() =>
      target.run(services, userId, fixture),
    );
    timings.push(ms);
    let count = 0;
    if (Array.isArray(result)) {
      count = result.length;
    } else if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (Array.isArray(obj.files)) count += obj.files.length;
      if (Array.isArray(obj.folders)) count += obj.folders.length;
      if (Array.isArray(obj.items)) count += obj.items.length;
    }
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

export const TARGETS: TargetRun[] = [
  {
    name: "files.findAll",
    run: (s, userId, f) =>
      s.filesService.findAll(userId, f.rootFolderId, undefined, false),
  },
  {
    name: "files.findFolders",
    run: (s, userId, f) =>
      s.filesService.findFolders(userId, f.rootFolderId, false),
  },
  {
    name: "files.search.all",
    run: (s, userId, f) =>
      s.filesService.search(userId, "bench"),
  },
  {
    name: "files.search.none",
    run: (s, userId) =>
      s.filesService.search(userId, "zzznomatchzzz"),
  },
  {
    name: "files.search.tenpct",
    run: (s, userId, f) =>
      s.filesService.search(userId, "benchsearchtoken"),
  },
  {
    name: "files.getTrash",
    run: (s, userId) => s.filesService.getTrash(userId),
  },
  {
    name: "uploads.listUploadSessions",
    run: (s, userId) => s.uploadsService.listUploadSessions(userId),
  },
  {
    name: "sharing.listUserShares",
    run: (s, userId) => s.sharingService.listUserShares(userId),
  },
];

export async function runScale(
  dataSource: DataSource,
  fixture: FixtureResult,
  config: BenchConfig,
  services: BenchServices,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const target of TARGETS) {
    const r = await runTarget(
      services,
      fixture.userId,
      fixture,
      target,
      config.runs,
      config.warmupRuns,
    );
    r.scale = 0;
    results.push(r);
  }

  return results;
}

export function summarize(
  results: ScenarioResult[],
  fixture: FixtureResult,
): object {
  return {
    fixture: {
      userId: fixture.userId,
      rootFolderId: fixture.rootFolderId,
      fileCount: fixture.fileCount,
      folderCount: fixture.folderCount,
      shareCount: fixture.shareCount,
      sessionCount: fixture.sessionCount,
      trashCount: fixture.trashCount,
    },
    scenarios: results.map((r) => ({
      name: r.name,
      scale: r.scale,
      runs: r.runs,
      rowCounts: r.rowCounts,
      timingsMs: r.timingsMs,
      medianMs: r.medianMs,
    })),
  };
}