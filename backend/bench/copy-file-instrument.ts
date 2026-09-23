import * as fsTypes from "fs";
import { EventLoopProbeSample } from "./event-loop-probe";

const fs = require("fs") as typeof fsTypes;

export interface CopyFileInstrumentHandle {
  start(): void;
  restore(): void;
  settled(): Promise<EventLoopProbeSample>;
  calls(): number;
  asyncAttempts(): number;
}

export function createCopyFileInstrument(): CopyFileInstrumentHandle {
  const original = fs.copyFileSync;
  const originalAsync = fs.promises.copyFile;
  let installed = false;
  let callCount = 0;
  let asyncCallCount = 0;
  let completion: Promise<EventLoopProbeSample> | undefined;

  return {
    start() {
      if (installed) return;
      installed = true;
      fs.copyFileSync = ((source, destination, mode) => {
        callCount++;
        return original(source, destination, mode);
      }) as typeof fs.copyFileSync;
      fs.promises.copyFile = (async (source, destination, mode) => {
        asyncCallCount++;
        const start = process.hrtime.bigint();
        let returned = false;
        const immediate = new Promise<{ delay: number; before: boolean }>(
          (resolve) => {
            setImmediate(() =>
              resolve({
                delay: Number(process.hrtime.bigint() - start) / 1e6,
                before: !returned,
              }),
            );
          },
        );
        const operation = originalAsync(source, destination, mode);
        completion = (async () => {
          await operation;
          returned = true;
          const operationMs = Number(process.hrtime.bigint() - start) / 1e6;
          const probe = await immediate;
          return {
            operationMs,
            immediateDelayMs: probe.delay,
            immediateRanBeforeReturn: probe.before,
          };
        })();
        return operation;
      }) as typeof fs.promises.copyFile;
    },
    restore() {
      if (!installed) return;
      fs.copyFileSync = original;
      fs.promises.copyFile = originalAsync;
      installed = false;
    },
    settled() {
      return completion ?? Promise.reject(new Error("Async copy was not attempted."));
    },
    calls() {
      return callCount;
    },
    asyncAttempts() {
      return asyncCallCount;
    },
  };
}
