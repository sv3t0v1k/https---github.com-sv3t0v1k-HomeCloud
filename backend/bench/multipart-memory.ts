import { monitorEventLoopDelay } from "perf_hooks";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";

export type MemoryPoint = NodeJS.MemoryUsage & { atMs: number; active: number };

export type CommandRunner = (command: string, args: string[]) => string;

export type MemorySafetyEvidence = {
  backendRuntime: "host-process" | "cgroup-v2";
  containerLimitSource: "not-applicable-host-process" | "cgroup-v2";
  platform: NodeJS.Platform;
  totalBytes: number;
  osFreeBytes: number;
  hostAvailableBytes: number;
  hostReserveBytes: number;
  containerLimitBytes: number | null;
  containerCurrentBytes: number | null;
  containerHeadroomBytes: number | null;
  raw: Record<string, string>;
  derived: Record<string, number | boolean | null>;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function integer(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Некорректный ${label}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Некорректный ${label}`);
  return result;
}

function vmField(output: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^${escaped}:\\s+(\\d+)\\.$`, "m"));
  if (!match) throw new Error(`Не найден vm_stat: ${name}`);
  return integer(match[1], `vm_stat ${name}`);
}

function readCgroupNumber(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw === "max") return null;
  return integer(raw, file);
}

export function collectMemorySafetyEvidence(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = (command, args) =>
    execFileSync(command, args, { encoding: "utf8" }),
  totalBytes = os.totalmem(),
  osFreeBytes = os.freemem(),
): MemorySafetyEvidence {
  if (platform !== "darwin") {
    const limit = readCgroupNumber("/sys/fs/cgroup/memory.max");
    const current = readCgroupNumber("/sys/fs/cgroup/memory.current");
    return {
      backendRuntime: limit === null ? "host-process" : "cgroup-v2",
      containerLimitSource:
        limit === null ? "not-applicable-host-process" : "cgroup-v2",
      platform,
      totalBytes,
      osFreeBytes,
      hostAvailableBytes: osFreeBytes,
      hostReserveBytes: Math.max(GIB, Math.floor(totalBytes * 0.15)),
      containerLimitBytes: limit,
      containerCurrentBytes: current,
      containerHeadroomBytes:
        limit === null || current === null
          ? null
          : Math.max(0, limit - current),
      raw: {},
      derived: { linuxOsFreePath: true },
    };
  }

  const memoryPressure = run("memory_pressure", []);
  const vmStat = run("vm_stat", []);
  const memSizeRaw = run("sysctl", ["-n", "hw.memsize"]).trim();
  const swapUsage = run("sysctl", ["vm.swapusage"]).trim();
  const physicalBytes = integer(memSizeRaw, "hw.memsize");
  if (physicalBytes !== totalBytes)
    throw new Error("Несогласованные значения физической памяти");
  const pageMatch = vmStat.match(
    /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\.?$/m,
  );
  const freePercentMatch = memoryPressure.match(
    /^System-wide memory free percentage: (\d+)%$/m,
  );
  const swapMatch = swapUsage.match(
    /^vm\.swapusage: total = ([0-9]+(?:\.[0-9]+)?)M\s+used = ([0-9]+(?:\.[0-9]+)?)M\s+free = ([0-9]+(?:\.[0-9]+)?)M\s+\(encrypted\)$/,
  );
  if (!pageMatch || !freePercentMatch || !swapMatch)
    throw new Error("Не удалось строго разобрать показатели памяти macOS");
  const pageBytes = integer(pageMatch[1], "размер страницы");
  const freePercent = integer(
    freePercentMatch[1],
    "memory_pressure percentage",
  );
  if (freePercent > 100)
    throw new Error("Некорректный memory_pressure percentage");
  const reclaimablePages =
    vmField(vmStat, "Pages free") +
    vmField(vmStat, "Pages inactive") +
    vmField(vmStat, "Pages speculative");
  const throttledPages = vmField(vmStat, "Pages throttled");
  const compressorPages = vmField(vmStat, "Pages occupied by compressor");
  const swapUsedBytes = Math.ceil(Number(swapMatch[2]) * MIB);
  if (
    ![swapUsedBytes, reclaimablePages * pageBytes].every(Number.isSafeInteger)
  )
    throw new Error("Переполнение показателей памяти macOS");
  const pressureAvailableBytes = Math.floor(
    (physicalBytes * freePercent) / 100,
  );
  const vmReclaimableBytes = reclaimablePages * pageBytes;
  const compressionPenaltyBytes = compressorPages * pageBytes;
  const pressureDetected = swapUsedBytes > 0 || throttledPages > 0;
  const conservativeAvailable = Math.max(
    0,
    Math.min(pressureAvailableBytes, vmReclaimableBytes),
  );
  const hostAvailableBytes = pressureDetected ? 0 : conservativeAvailable;
  return {
    backendRuntime: "host-process",
    containerLimitSource: "not-applicable-host-process",
    platform,
    totalBytes: physicalBytes,
    osFreeBytes,
    hostAvailableBytes,
    hostReserveBytes: Math.max(2 * GIB, Math.floor(physicalBytes * 0.15)),
    containerLimitBytes: null,
    containerCurrentBytes: null,
    containerHeadroomBytes: null,
    raw: { memoryPressure, vmStat, memSize: memSizeRaw, swapUsage },
    derived: {
      freePercent,
      pageBytes,
      reclaimablePages,
      vmReclaimableBytes,
      pressureAvailableBytes,
      compressorPages,
      compressionPenaltyBytes,
      swapUsedBytes,
      throttledPages,
      pressureDetected,
    },
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

export function assertSafePlan(
  chunkBytes: number,
  concurrency: number,
  evidence: MemorySafetyEvidence,
): {
  model: Record<string, number>;
  ownedEstimateBytes: number;
  hostHeadroomAfterReserveBytes: number;
  containerHeadroomBytes: number | null;
  usableHeadroomBytes: number;
} {
  if (
    ![chunkBytes, concurrency, evidence.hostAvailableBytes].every(
      Number.isSafeInteger,
    )
  )
    throw new Error("Параметры safety должны быть safe integer");
  if (
    ![25, 50].includes(chunkBytes / 1024 / 1024) ||
    ![1, 2, 4].includes(concurrency)
  )
    throw new Error("Цель вне разрешённой матрицы");
  // Incremental worst-case ownership while requests overlap: the client payload,
  // FormData/Blob serialization, Multer's complete in-memory buffer, and one
  // in-flight transport copy. Existing runtime/DB memory is already reflected in
  // hostAvailableBytes. The host reserve covers unmodelled OS/runtime growth.
  const perComponentBytes = chunkBytes * concurrency;
  const model = {
    clientPayloadBytes: perComponentBytes,
    clientMultipartCopyBytes: perComponentBytes,
    backendMulterBytes: perComponentBytes,
    transportTransientBytes: perComponentBytes,
  };
  const ownedEstimate = Object.values(model).reduce(
    (sum, value) => sum + value,
    0,
  );
  const hostHeadroom = Math.max(
    0,
    evidence.hostAvailableBytes - evidence.hostReserveBytes,
  );
  const containerHeadroom =
    evidence.containerHeadroomBytes === null
      ? Number.POSITIVE_INFINITY
      : evidence.containerHeadroomBytes;
  const usableHeadroom = Math.min(hostHeadroom, containerHeadroom);
  if (ownedEstimate > usableHeadroom)
    throw new Error(
      `NOT_RUN_SAFETY: estimate=${Math.ceil(ownedEstimate)} headroom=${Math.floor(usableHeadroom)}`,
    );
  return {
    model,
    ownedEstimateBytes: ownedEstimate,
    hostHeadroomAfterReserveBytes: hostHeadroom,
    containerHeadroomBytes: evidence.containerHeadroomBytes,
    usableHeadroomBytes: usableHeadroom,
  };
}

export function summarizeMemory(points: MemoryPoint[], baseline: MemoryPoint) {
  if (points.length === 0) throw new Error("Нет backend samples");
  const peak = (field: keyof NodeJS.MemoryUsage) =>
    Math.max(...points.map((p) => p[field]));
  return {
    sampleCount: points.length,
    baseline,
    peak: {
      rss: peak("rss"),
      heapUsed: peak("heapUsed"),
      external: peak("external"),
      arrayBuffers: peak("arrayBuffers"),
    },
    peakDelta: {
      rss: peak("rss") - baseline.rss,
      heapUsed: peak("heapUsed") - baseline.heapUsed,
      external: peak("external") - baseline.external,
      arrayBuffers: peak("arrayBuffers") - baseline.arrayBuffers,
    },
  };
}

export function startBackendProbe(intervalMs = 10) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5 || intervalMs > 100)
    throw new Error("Некорректный sampling interval");
  const started = performance.now();
  let active = 0;
  let maxActive = 0;
  const points: MemoryPoint[] = [];
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const capture = () =>
    points.push({
      ...process.memoryUsage(),
      atMs: performance.now() - started,
      active,
    });
  capture();
  const timer = setInterval(capture, intervalMs);
  timer.unref();
  return {
    enter() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      capture();
    },
    leave() {
      active -= 1;
      capture();
    },
    snapshot: capture,
    finish() {
      clearInterval(timer);
      capture();
      loop.disable();
      return {
        points,
        maxActive,
        finalActive: active,
        eventLoop: {
          resolutionMs: 10,
          p50Ms: loop.percentile(50) / 1e6,
          p95Ms: loop.percentile(95) / 1e6,
          p99Ms: loop.percentile(99) / 1e6,
          maxMs: loop.max / 1e6,
        },
      };
    },
  };
}
