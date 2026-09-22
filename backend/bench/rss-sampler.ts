export interface RssSnapshot {
  before: number;
  peak: number;
  after: number;
}

export interface RssSamplerHandle {
  start(): void;
  stop(): void;
  snapshot(): RssSnapshot;
}

export function createRssSampler(intervalMs = 1): RssSamplerHandle {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive finite number");
  }

  let timer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;
  let before = 0;
  let peak = 0;
  let after = 0;

  function sample(): void {
    const rss = process.memoryUsage().rss;
    if (rss > peak) {
      peak = rss;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      before = process.memoryUsage().rss;
      peak = before;
      timer = setInterval(sample, intervalMs);
      if (timer.unref) {
        timer.unref();
      }
    },
    stop() {
      if (!started || stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Final sample
      sample();
      after = process.memoryUsage().rss;
    },
    snapshot() {
      return { before, peak, after };
    },
  };
}