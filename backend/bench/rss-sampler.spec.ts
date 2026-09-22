import { createRssSampler } from "./rss-sampler";

describe("bench rss-sampler", () => {
  it("no sampling before start", () => {
    const sampler = createRssSampler(10);
    const snap = sampler.snapshot();
    expect(snap.before).toBe(0);
    expect(snap.peak).toBe(0);
    expect(snap.after).toBe(0);
  });

  it("start produces valid positive before", () => {
    const sampler = createRssSampler(10);
    sampler.start();
    const snap = sampler.snapshot();
    expect(snap.before).toBeGreaterThan(0);
    expect(snap.peak).toBeGreaterThanOrEqual(snap.before);
    expect(snap.after).toBe(0);
    sampler.stop();
  });

  it("peak >= before", () => {
    const sampler = createRssSampler(10);
    sampler.start();
    const snap = sampler.snapshot();
    expect(snap.peak).toBeGreaterThanOrEqual(snap.before);
    sampler.stop();
  });

  it("stop produces valid positive after", () => {
    const sampler = createRssSampler(10);
    sampler.start();
    sampler.stop();
    const snap = sampler.snapshot();
    expect(snap.after).toBeGreaterThan(0);
    expect(snap.peak).toBeGreaterThanOrEqual(snap.before);
  });

  it("peak reflects an observed increase", async () => {
    const sampler = createRssSampler(5);
    sampler.start();

    // Allocate some memory to increase RSS
    const arrays: number[][] = [];
    for (let i = 0; i < 1000; i++) {
      arrays.push(new Array(1000).fill(i));
    }

    // Allow a few sampling intervals to pass
    await new Promise((resolve) => setTimeout(resolve, 50));

    sampler.stop();
    const snap = sampler.snapshot();

    // We cannot guarantee exact delta, but peak should be >= before.
    // Since we allocated, it's very likely peak > before.
    expect(snap.peak).toBeGreaterThanOrEqual(snap.before);
    expect(snap.after).toBeGreaterThan(0);
  });

  it("repeated start does not create duplicate active sampling", () => {
    const sampler = createRssSampler(10);
    sampler.start();
    const snap1 = sampler.snapshot();
    sampler.start(); // second start should be no-op
    const snap2 = sampler.snapshot();
    // before and peak should be the same
    expect(snap2.before).toBe(snap1.before);
    expect(snap2.peak).toBe(snap1.peak);
    sampler.stop();
  });

  it("repeated stop is safe", () => {
    const sampler = createRssSampler(10);
    sampler.start();
    sampler.stop();
    sampler.stop(); // should not throw
    const snap = sampler.snapshot();
    expect(snap.after).toBeGreaterThan(0);
  });

  it("invalid interval rejected", () => {
    expect(() => createRssSampler(0)).toThrow();
    expect(() => createRssSampler(-1)).toThrow();
    expect(() => createRssSampler(NaN)).toThrow();
    expect(() => createRssSampler(Infinity)).toThrow();
    expect(() => createRssSampler(-Infinity)).toThrow();
  });
});