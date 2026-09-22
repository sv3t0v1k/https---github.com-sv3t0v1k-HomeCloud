import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createFsInstrument } from "./fs-instrument";

describe("bench fs-instrument", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-bench-fsinst-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("inactive -> calls not counted", () => {
    const inst = createFsInstrument();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "x");
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(f).size).toBe(1);
    expect(inst.snapshot()).toEqual({ existsSync: 0, statSync: 0 });
    inst.restore();
  });

  it("active -> counted exactly", () => {
    const inst = createFsInstrument();
    inst.start();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "x");
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(f).size).toBe(1);
    expect(inst.snapshot()).toEqual({ existsSync: 1, statSync: 1 });
    inst.restore();
  });

  it("reset works", () => {
    const inst = createFsInstrument();
    inst.start();
    fs.existsSync(tmp);
    inst.reset();
    expect(inst.snapshot()).toEqual({ existsSync: 0, statSync: 0 });
    inst.restore();
  });

  it("original behavior/return value preserved", () => {
    const inst = createFsInstrument();
    inst.start();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "hello");
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "missing"))).toBe(false);
    expect(fs.statSync(f).size).toBe(5);
    inst.restore();
  });

  it("thrown error preserved", () => {
    const inst = createFsInstrument();
    inst.start();
    expect(() => fs.statSync(path.join(tmp, "nope"))).toThrow();
    expect(inst.snapshot().statSync).toBe(1);
    inst.restore();
  });

  it("restore stops counting", () => {
    const inst = createFsInstrument();
    inst.start();
    fs.existsSync(tmp);
    inst.restore();
    fs.existsSync(tmp);
    fs.statSync(tmp);
    expect(inst.snapshot()).toEqual({ existsSync: 1, statSync: 0 });
  });

  it("repeated install/restore is safe", () => {
    const inst = createFsInstrument();
    inst.start();
    inst.restore();
    inst.start();
    fs.existsSync(tmp);
    expect(inst.snapshot()).toEqual({ existsSync: 1, statSync: 0 });
    inst.restore();
    inst.restore();
    fs.existsSync(tmp);
    expect(inst.snapshot()).toEqual({ existsSync: 1, statSync: 0 });
  });
});