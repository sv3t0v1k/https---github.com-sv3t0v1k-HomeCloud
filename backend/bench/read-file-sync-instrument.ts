import * as fsTypes from "fs";

const fs = require("fs") as typeof fsTypes;

export interface ReadFileSyncSample {
  durationMs: number;
  immediateDelayMs: number;
  timerDelayMs: number;
  immediateRanBeforeReadReturn: boolean;
  timerRanBeforeReadReturn: boolean;
  immediateRanBeforeServiceReturn: boolean;
  timerRanBeforeServiceReturn: boolean;
}

export interface ReadFileSyncSnapshot {
  calls: number;
  cumulativeDurationMs: number;
  maxDurationMs: number;
  maxImmediateDelayMs: number;
  maxTimerDelayMs: number;
  immediateBeforeReadReturn: number;
  timerBeforeReadReturn: number;
  immediateBeforeServiceReturn: number;
  timerBeforeServiceReturn: number;
  samples: ReadFileSyncSample[];
}

export interface ReadFileSyncInstrumentHandle {
  start(): void;
  markServiceReturned(): void;
  settled(): Promise<ReadFileSyncSnapshot>;
  restore(): void;
}

export function createReadFileSyncInstrument(
  includedPaths: readonly string[],
): ReadFileSyncInstrumentHandle {
  const original = fs.readFileSync;
  const included = new Set(
    includedPaths.map((filePath) => require("path").resolve(filePath)),
  );
  const pending: Promise<void>[] = [];
  const samples: ReadFileSyncSample[] = [];
  let installed = false;
  let serviceReturned = false;

  return {
    start() {
      if (installed) return;
      installed = true;
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        const candidate = args[0];
        if (
          typeof candidate !== "string" ||
          !included.has(require("path").resolve(candidate))
        ) {
          return original.apply(fs, args as any);
        }
        const probeStart = process.hrtime.bigint();
        let readReturned = false;
        let resolveImmediate: () => void;
        let resolveTimer: () => void;
        const sample: ReadFileSyncSample = {
          durationMs: 0,
          immediateDelayMs: 0,
          timerDelayMs: 0,
          immediateRanBeforeReadReturn: false,
          timerRanBeforeReadReturn: false,
          immediateRanBeforeServiceReturn: false,
          timerRanBeforeServiceReturn: false,
        };
        const immediate = new Promise<void>((resolve) => {
          resolveImmediate = resolve;
        });
        const timer = new Promise<void>((resolve) => {
          resolveTimer = resolve;
        });
        setImmediate(() => {
          sample.immediateDelayMs =
            Number(process.hrtime.bigint() - probeStart) / 1e6;
          sample.immediateRanBeforeReadReturn = !readReturned;
          sample.immediateRanBeforeServiceReturn = !serviceReturned;
          resolveImmediate();
        });
        setTimeout(() => {
          sample.timerDelayMs =
            Number(process.hrtime.bigint() - probeStart) / 1e6;
          sample.timerRanBeforeReadReturn = !readReturned;
          sample.timerRanBeforeServiceReturn = !serviceReturned;
          resolveTimer();
        }, 0);
        const readStart = process.hrtime.bigint();
        try {
          return original.apply(fs, args as any);
        } finally {
          sample.durationMs = Number(process.hrtime.bigint() - readStart) / 1e6;
          readReturned = true;
          samples.push(sample);
          pending.push(Promise.all([immediate, timer]).then(() => undefined));
        }
      }) as typeof fs.readFileSync;
    },
    markServiceReturned() {
      serviceReturned = true;
    },
    async settled() {
      await Promise.all(pending);
      return {
        calls: samples.length,
        cumulativeDurationMs: samples.reduce(
          (sum, sample) => sum + sample.durationMs,
          0,
        ),
        maxDurationMs: Math.max(
          0,
          ...samples.map((sample) => sample.durationMs),
        ),
        maxImmediateDelayMs: Math.max(
          0,
          ...samples.map((sample) => sample.immediateDelayMs),
        ),
        maxTimerDelayMs: Math.max(
          0,
          ...samples.map((sample) => sample.timerDelayMs),
        ),
        immediateBeforeReadReturn: samples.filter(
          (sample) => sample.immediateRanBeforeReadReturn,
        ).length,
        timerBeforeReadReturn: samples.filter(
          (sample) => sample.timerRanBeforeReadReturn,
        ).length,
        immediateBeforeServiceReturn: samples.filter(
          (sample) => sample.immediateRanBeforeServiceReturn,
        ).length,
        timerBeforeServiceReturn: samples.filter(
          (sample) => sample.timerRanBeforeServiceReturn,
        ).length,
        samples: samples.map((sample) => ({ ...sample })),
      };
    },
    restore() {
      if (!installed) return;
      fs.readFileSync = original;
      installed = false;
    },
  };
}
