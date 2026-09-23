import * as fsTypes from "fs";
import { createEventLoopProbe, EventLoopProbeSample } from "./event-loop-probe";

const fs = require("fs") as typeof fsTypes;

export interface CopyFileInstrumentHandle {
  start(): void;
  restore(): void;
  settled(): Promise<EventLoopProbeSample>;
  calls(): number;
}

export function createCopyFileInstrument(): CopyFileInstrumentHandle {
  const original = fs.copyFileSync;
  const probe = createEventLoopProbe();
  let installed = false;
  let callCount = 0;

  return {
    start() {
      if (installed) return;
      installed = true;
      fs.copyFileSync = ((source, destination, mode) => {
        callCount++;
        return probe.run(() => original(source, destination, mode));
      }) as typeof fs.copyFileSync;
    },
    restore() {
      if (!installed) return;
      fs.copyFileSync = original;
      installed = false;
    },
    settled() {
      return probe.settled();
    },
    calls() {
      return callCount;
    },
  };
}
