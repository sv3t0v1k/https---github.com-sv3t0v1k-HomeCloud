import * as fsTypes from "fs";
const fs = require("fs") as typeof fsTypes;

export interface WriteStreamInstrumentCounters {
  createWriteStream: number;
  write: number;
  writeFalse: number;
  maxWritableLength: number;
  drain: number;
}

export interface WriteStreamInstrumentHandle {
  start(): void;
  snapshot(): WriteStreamInstrumentCounters;
  restore(): void;
}

export function createWriteStreamInstrument(): WriteStreamInstrumentHandle {
  const counters: WriteStreamInstrumentCounters = {
    createWriteStream: 0,
    write: 0,
    writeFalse: 0,
    maxWritableLength: 0,
    drain: 0,
  };
  let installed = false;
  let originalCreateWriteStream: typeof fs.createWriteStream;
  const wrappedStreams = new Set<fsTypes.WriteStream>();

  function wrapWriteStream(stream: fsTypes.WriteStream): fsTypes.WriteStream {
    const originalWrite = stream.write.bind(stream);
    stream.write = function (
      chunk: any,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void
    ): boolean {
      const ret = originalWrite(chunk, encoding as any, callback);
      counters.write++;
      if (ret === false) {
        counters.writeFalse++;
      }
      if (typeof stream.writableLength === "number") {
        if (stream.writableLength > counters.maxWritableLength) {
          counters.maxWritableLength = stream.writableLength;
        }
      }
      return ret;
    } as typeof stream.write;

    stream.on("drain", () => {
      counters.drain++;
    });

    wrappedStreams.add(stream);
    return stream;
  }

  function unwrapWriteStream(stream: fsTypes.WriteStream): void {
    wrappedStreams.delete(stream);
  }

  return {
    start() {
      if (installed) return;
      installed = true;
      originalCreateWriteStream = fs.createWriteStream;
      fs.createWriteStream = function (
        path: fsTypes.PathLike,
        options?: string | any
      ): fsTypes.WriteStream {
        counters.createWriteStream++;
        const stream = originalCreateWriteStream.call(fs, path, options);
        return wrapWriteStream(stream);
      } as typeof fs.createWriteStream;
    },
    snapshot() {
      return { ...counters };
    },
    restore() {
      if (!installed) return;
      installed = false;
      fs.createWriteStream = originalCreateWriteStream;
    },
  };
}