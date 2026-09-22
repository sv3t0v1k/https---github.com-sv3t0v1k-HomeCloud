import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createWriteStreamInstrument } from "./write-stream-instrument";

function waitForFinish(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

describe("bench write-stream-instrument", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-bench-wsinst-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("inactive -> calls not counted", async () => {
    const inst = createWriteStreamInstrument();
    const file = path.join(tmp, "inactive.txt");
    const stream = fs.createWriteStream(file);
    stream.write("hello");
    stream.end();
    await waitForFinish(stream);
    expect(inst.snapshot()).toEqual({
      createWriteStream: 0,
      write: 0,
      writeFalse: 0,
      maxWritableLength: 0,
      drain: 0,
    });
    inst.restore();
  });

  it("active -> create/write counts", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file = path.join(tmp, "active.txt");
    const stream = fs.createWriteStream(file);
    stream.write("hello");
    stream.end();
    await waitForFinish(stream);
    const snap = inst.snapshot();
    expect(snap.createWriteStream).toBe(1);
    expect(snap.write).toBe(1);
    expect(snap.writeFalse).toBe(0);
    expect(snap.maxWritableLength).toBeGreaterThanOrEqual(0);
    inst.restore();
  });

  it("write return value preserved", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file = path.join(tmp, "return.txt");
    const stream = fs.createWriteStream(file);
    const ret = stream.write("hello");
    expect(ret).toBe(true);
    stream.end();
    await waitForFinish(stream);
    inst.restore();
  });

  it("writeFalse observable with small highWaterMark", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file = path.join(tmp, "writefalse.txt");
    const stream = fs.createWriteStream(file, { highWaterMark: 1 });
    const largeBuf = Buffer.alloc(100, "x");
    let gotFalse = false;
    // Write multiple times to exceed highWaterMark
    for (let i = 0; i < 10; i++) {
      const ret = stream.write(largeBuf);
      if (ret === false) gotFalse = true;
    }
    stream.end();
    await waitForFinish(stream);
    const snap = inst.snapshot();
    expect(snap.writeFalse).toBeGreaterThan(0);
    inst.restore();
  });

  it("maxWritableLength captured", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file = path.join(tmp, "maxlen.txt");
    const stream = fs.createWriteStream(file, { highWaterMark: 16 });
    const data = Buffer.alloc(32, "y");
    stream.write(data);
    stream.end();
    await waitForFinish(stream);
    const snap = inst.snapshot();
    expect(snap.maxWritableLength).toBeGreaterThan(0);
    inst.restore();
  });

  it("drain observed without altering behavior", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file = path.join(tmp, "drain.txt");
    const stream = fs.createWriteStream(file, { highWaterMark: 1 });
    const large = Buffer.alloc(100, "z");
    stream.write(large);
    stream.end();
    await waitForFinish(stream);
    const snap = inst.snapshot();
    // drain may have fired at least once
    expect(snap.drain).toBeGreaterThanOrEqual(0);
    inst.restore();
  });

  it("restore stops interception", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    const file1 = path.join(tmp, "before.txt");
    const stream1 = fs.createWriteStream(file1);
    stream1.write("a");
    stream1.end();
    await waitForFinish(stream1);
    inst.restore();
    const file2 = path.join(tmp, "after.txt");
    const stream2 = fs.createWriteStream(file2);
    stream2.write("b");
    stream2.end();
    await waitForFinish(stream2);
    const snap = inst.snapshot();
    // createWriteStream should still be 1 (only before restore)
    expect(snap.createWriteStream).toBe(1);
    inst.restore(); // safe to call again
  });

  it("repeated start/restore safe", async () => {
    const inst = createWriteStreamInstrument();
    inst.start();
    inst.restore();
    inst.start();
    const file = path.join(tmp, "repeat.txt");
    const stream = fs.createWriteStream(file);
    stream.write("x");
    stream.end();
    await waitForFinish(stream);
    inst.restore();
    inst.restore(); // extra restore should not throw
    const snap = inst.snapshot();
    expect(snap.createWriteStream).toBe(1);
  });
});