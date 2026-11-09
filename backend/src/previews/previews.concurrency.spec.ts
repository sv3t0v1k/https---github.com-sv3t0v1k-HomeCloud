import { ServiceUnavailableException } from "@nestjs/common";
import { PreviewsService } from "./previews.service";

type SlotService = {
  withThumbnailSlot<T>(run: () => Promise<T>): Promise<T>;
};

describe("Thumbnail concurrency protection", () => {
  function createSlot() {
    const service = new PreviewsService({} as never, {} as never);
    return (service as unknown as SlotService)
      .withThumbnailSlot.bind(service);
  }

  it("runs two tasks, queues sixteen and rejects overflow", async () => {
    const slot = createSlot();

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    let running = 0;
    let maximum = 0;
    let started = 0;

    const jobs = Array.from({ length: 18 }, (_, index) =>
      slot(async () => {
        started += 1;
        running += 1;
        maximum = Math.max(maximum, running);

        await barrier;
        running -= 1;
        return index;
      }),
    );

    expect(started).toBe(2);

    await expect(slot(async () => 99))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    release();

    await expect(Promise.all(jobs))
      .resolves.toEqual(Array.from({ length: 18 }, (_, i) => i));

    expect(started).toBe(18);
    expect(maximum).toBe(2);
    expect(running).toBe(0);

    await expect(slot(async () => 100)).resolves.toBe(100);
  });

  it("expires queued requests without leaking capacity", async () => {
    jest.useFakeTimers();

    try {
      const slot = createSlot();

      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = slot(() => hold);
      const second = slot(() => hold);

      const waiting = slot(async () => "should not run");
      const assertion = (async () => {
        await expect(waiting)
          .rejects.toBeInstanceOf(ServiceUnavailableException);
      })();

      await jest.advanceTimersByTimeAsync(5_001);
      await assertion;

      release();
      await Promise.all([first, second]);

      await expect(slot(async () => "recovered"))
        .resolves.toBe("recovered");
    } finally {
      jest.useRealTimers();
    }
  });

  it("releases a processing slot after an exception", async () => {
    const slot = createSlot();

    await expect(slot(async () => {
      throw new Error("Decoder failed");
    })).rejects.toThrow("Decoder failed");

    await expect(slot(async () => "recovered"))
      .resolves.toBe("recovered");
  });
});
