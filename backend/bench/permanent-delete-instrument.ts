import * as fsTypes from "fs";
const fs = require("fs") as typeof fsTypes;

export interface SyncCallTiming {
  calls: number;
  cumulativeMs: number;
  maxMs: number;
}

export interface AsyncCallTiming extends SyncCallTiming {
  maxInFlight: number;
}

export interface PermanentDeleteProbeSample {
  existsSync: SyncCallTiming;
  unlinkSync: SyncCallTiming;
  asyncUnlink: AsyncCallTiming;
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
  const asyncUnlink: AsyncCallTiming = {
    calls: 0,
    cumulativeMs: 0,
    maxMs: 0,
    maxInFlight: 0,
  };
  let asyncUnlinkInFlight = 0;
  let installed = false;
  let firstCallAt: bigint | undefined;
  let serviceReturned = false;
  let resolveProbe:
    | ((probe: {
        immediateDelayMs: number;
        immediateRanBeforeServiceReturn: boolean;
      }) => void)
    | undefined;
  const completion = new Promise<{
    immediateDelayMs: number;
    immediateRanBeforeServiceReturn: boolean;
  }>((resolve) => {
    resolveProbe = resolve;
  });
  let originalExistsSync: typeof fs.existsSync;
  let originalUnlinkSync: typeof fs.unlinkSync;
  let originalAsyncUnlink: typeof fs.promises.unlink;

  const beginProbe = () => {
    if (firstCallAt) return;
    firstCallAt = process.hrtime.bigint();
    setImmediate(() => {
      const callbackAt = process.hrtime.bigint();
      resolveProbe?.({
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
  const mutablePromises = fs.promises as {
    unlink: typeof fs.promises.unlink;
  };

  return {
    start() {
      if (installed) return;
      installed = true;
      originalExistsSync = fs.existsSync;
      originalUnlinkSync = fs.unlinkSync;
      originalAsyncUnlink = fs.promises.unlink;
      mutableFs.existsSync = ((path) =>
        time(existsSync, () =>
          originalExistsSync(path),
        )) as typeof fs.existsSync;
      mutableFs.unlinkSync = ((path) =>
        time(unlinkSync, () =>
          originalUnlinkSync(path),
        )) as typeof fs.unlinkSync;
      mutablePromises.unlink = (async (path) => {
        beginProbe();
        const start = process.hrtime.bigint();
        asyncUnlink.calls++;
        asyncUnlinkInFlight++;
        asyncUnlink.maxInFlight = Math.max(
          asyncUnlink.maxInFlight,
          asyncUnlinkInFlight,
        );
        try {
          await originalAsyncUnlink(path);
        } finally {
          asyncUnlinkInFlight--;
          const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
          asyncUnlink.cumulativeMs += elapsed;
          asyncUnlink.maxMs = Math.max(asyncUnlink.maxMs, elapsed);
        }
      }) as typeof fs.promises.unlink;
    },
    markServiceReturned() {
      serviceReturned = true;
    },
    async settled() {
      if (!firstCallAt) {
        throw new Error("No deletion call was observed.");
      }
      const probe = await completion;
      return {
        existsSync: { ...existsSync },
        unlinkSync: { ...unlinkSync },
        asyncUnlink: { ...asyncUnlink },
        ...probe,
      };
    },
    restore() {
      if (!installed) return;
      installed = false;
      mutableFs.existsSync = originalExistsSync;
      mutableFs.unlinkSync = originalUnlinkSync;
      mutablePromises.unlink = originalAsyncUnlink;
    },
  };
}
