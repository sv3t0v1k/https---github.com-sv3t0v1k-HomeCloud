import * as fsTypes from "fs";
const fs = require("fs") as typeof fsTypes;

export interface SyncCallTiming {
  calls: number;
  cumulativeMs: number;
  maxMs: number;
}

export interface PermanentDeleteProbeSample {
  existsSync: SyncCallTiming;
  unlinkSync: SyncCallTiming;
  immediateDelayMs: number;
  immediateRanBeforeServiceReturn: boolean;
}

export interface PermanentDeleteInstrument {
  start(): void;
  markServiceReturned(): void;
  settled(): Promise<PermanentDeleteProbeSample>;
  restore(): void;
}

export function createPermanentDeleteInstrument(): PermanentDeleteInstrument {
  const existsSync: SyncCallTiming = { calls: 0, cumulativeMs: 0, maxMs: 0 };
  const unlinkSync: SyncCallTiming = { calls: 0, cumulativeMs: 0, maxMs: 0 };
  let installed = false;
  let firstCallAt: bigint | undefined;
  let serviceReturned = false;
  let resolveSample: ((sample: PermanentDeleteProbeSample) => void) | undefined;
  const completion = new Promise<PermanentDeleteProbeSample>((resolve) => {
    resolveSample = resolve;
  });
  let originalExistsSync: typeof fs.existsSync;
  let originalUnlinkSync: typeof fs.unlinkSync;

  const beginProbe = () => {
    if (firstCallAt) return;
    firstCallAt = process.hrtime.bigint();
    setImmediate(() => {
      const callbackAt = process.hrtime.bigint();
      resolveSample?.({
        existsSync: { ...existsSync },
        unlinkSync: { ...unlinkSync },
        immediateDelayMs: Number(callbackAt - firstCallAt!) / 1e6,
        immediateRanBeforeServiceReturn: !serviceReturned,
      });
    });
  };

  const time = <T>(bucket: SyncCallTiming, operation: () => T): T => {
    beginProbe();
    const start = process.hrtime.bigint();
    try {
      return operation();
    } finally {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      bucket.calls++;
      bucket.cumulativeMs += elapsed;
      bucket.maxMs = Math.max(bucket.maxMs, elapsed);
    }
  };

  const mutableFs = fs as unknown as {
    existsSync: typeof fs.existsSync;
    unlinkSync: typeof fs.unlinkSync;
  };

  return {
    start() {
      if (installed) return;
      installed = true;
      originalExistsSync = fs.existsSync;
      originalUnlinkSync = fs.unlinkSync;
      mutableFs.existsSync = ((path) =>
        time(existsSync, () =>
          originalExistsSync(path),
        )) as typeof fs.existsSync;
      mutableFs.unlinkSync = ((path) =>
        time(unlinkSync, () =>
          originalUnlinkSync(path),
        )) as typeof fs.unlinkSync;
    },
    markServiceReturned() {
      serviceReturned = true;
    },
    settled() {
      if (!firstCallAt) {
        return Promise.reject(
          new Error("No synchronous deletion call was observed."),
        );
      }
      return completion;
    },
    restore() {
      if (!installed) return;
      installed = false;
      mutableFs.existsSync = originalExistsSync;
      mutableFs.unlinkSync = originalUnlinkSync;
    },
  };
}
