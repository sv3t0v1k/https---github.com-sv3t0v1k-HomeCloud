import * as fsTypes from "fs";
const fs = require("fs") as typeof fsTypes;

export interface FsInstrumentCounters {
  existsSync: number;
  statSync: number;
}

export interface FsInstrumentHandle {
  start(): void;
  reset(): void;
  snapshot(): FsInstrumentCounters;
  restore(): void;
}

export function createFsInstrument(): FsInstrumentHandle {
  const counters: FsInstrumentCounters = { existsSync: 0, statSync: 0 };
  let installed = false;
  let originalExistsSync: typeof fs.existsSync;
  let originalStatSync: typeof fs.statSync;

  const wrapExistsSync = (p: Parameters<typeof fs.existsSync>[0]) => {
    counters.existsSync++;
    return originalExistsSync(p);
  };
  const wrapStatSync = (p: Parameters<typeof fs.statSync>[0]) => {
    counters.statSync++;
    return originalStatSync(p);
  };

  const mutableFs = fs as unknown as {
    existsSync: typeof fs.existsSync;
    statSync: typeof fs.statSync;
  };

  return {
    start() {
      if (installed) return;
      installed = true;
      originalExistsSync = fs.existsSync;
      originalStatSync = fs.statSync;
      mutableFs.existsSync = wrapExistsSync as typeof fs.existsSync;
      mutableFs.statSync = wrapStatSync as typeof fs.statSync;
    },
    reset() {
      counters.existsSync = 0;
      counters.statSync = 0;
    },
    snapshot() {
      return { ...counters };
    },
    restore() {
      if (!installed) return;
      installed = false;
      mutableFs.existsSync = originalExistsSync;
      mutableFs.statSync = originalStatSync;
    },
  };
}