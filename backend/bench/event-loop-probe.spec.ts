import { createEventLoopProbe } from "./event-loop-probe";

function blockFor(ms: number): void {
  const until = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < until) {
    // Intentional deterministic synthetic synchronous block.
  }
}

describe("event-loop probe", () => {
  it("detects a known synchronous block", async () => {
    const probe = createEventLoopProbe();
    probe.run(() => blockFor(25));
    const sample = await probe.settled();
    expect(sample.operationMs).toBeGreaterThanOrEqual(20);
    expect(sample.immediateDelayMs).toBeGreaterThanOrEqual(20);
    expect(sample.immediateRanBeforeReturn).toBe(false);
  });

  it("does not attribute an asynchronous wait to a short sync operation", async () => {
    const probe = createEventLoopProbe();
    probe.run(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const sample = await probe.settled();
    expect(sample.operationMs).toBeLessThan(10);
    expect(sample.immediateDelayMs).toBeLessThan(20);
    expect(sample.immediateRanBeforeReturn).toBe(false);
  });
});
