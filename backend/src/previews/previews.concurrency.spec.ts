import { ServiceUnavailableException } from "@nestjs/common";
import { PreviewsService } from "./previews.service";

type SlotService = {
  withThumbnailSlot<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
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

  it("removes an aborted waiter without consuming capacity", async () => {
    const slot = createSlot();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const running = [slot(() => hold), slot(() => hold)];
    const controller = new AbortController();
    let entered = false;

    const waiting = slot(async () => {
      entered = true;
    }, controller.signal);

    const rejected = (async () => {
      await expect(waiting)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    controller.abort();
    await rejected;
    expect(entered).toBe(false);

    const next = Array.from({ length: 16 }, () =>
      slot(async () => "ok"),
    );

    await expect(slot(async () => "overflow"))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    release();
    await Promise.all(running);
    await expect(Promise.all(next))
      .resolves.toEqual(Array(16).fill("ok"));
  });

  it("holds an aborted active slot until actual completion", async () => {
    const slot = createSlot();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const controller = new AbortController();
    const first = slot(() => hold, controller.signal);
    const rejected = (async () => {
      await expect(first)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    const second = slot(() => hold);
    let started = false;

    const third = slot(async () => {
      started = true;
      return "third";
    });

    controller.abort();
    await Promise.resolve();
    expect(started).toBe(false);

    release();
    await rejected;
    await second;
    await expect(third).resolves.toBe("third");
    expect(started).toBe(true);

    await expect(slot(async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("rejects cancellation before admission", async () => {
    const slot = createSlot();
    const controller = new AbortController();
    controller.abort();

    let started = false;
    await expect(slot(async () => {
      started = true;
    }, controller.signal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(started).toBe(false);
    await expect(slot(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects cancellation between queue wake-up and execution", async () => {
    const slot = createSlot();

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = slot(() => hold);
    const second = slot(() => hold);

    const controller = new AbortController();
    let entered = false;

    const waiting = slot(async () => {
      entered = true;
      return "unexpected";
    }, controller.signal);

    const rejected = (async () => {
      await expect(waiting)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    release();

    // Active tasks wake the waiter in microtasks. Abort before
    // the awakened waiter can enter its own task callback.
    queueMicrotask(() => controller.abort());

    await rejected;
    await Promise.all([first, second]);

    expect(entered).toBe(false);

    await expect(slot(async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("handles repeated abort and timeout without leaking capacity", async () => {
    jest.useFakeTimers();

    let release!: () => void;

    try {
      const slot = createSlot();
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });

      const running = [slot(() => hold), slot(() => hold)];
      const controller = new AbortController();
      let entered = 0;

      const cancelled = slot(async () => {
        entered += 1;
      }, controller.signal);

      const cancelledCheck = (async () => {
        await expect(cancelled)
          .rejects.toBeInstanceOf(ServiceUnavailableException);
      })();

      const expired = slot(async () => {
        entered += 1;
      });

      const expiredCheck = (async () => {
        await expect(expired)
          .rejects.toBeInstanceOf(ServiceUnavailableException);
      })();

      controller.abort();
      controller.abort();

      await cancelledCheck;
      await jest.advanceTimersByTimeAsync(5_001);
      await expiredCheck;

      expect(entered).toBe(0);

      const next = Array.from({ length: 16 }, () =>
        slot(async () => "accepted"),
      );

      await expect(slot(async () => "overflow"))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      release();
      await Promise.all(running);

      await expect(Promise.all(next))
        .resolves.toEqual(Array(16).fill("accepted"));

      await expect(slot(async () => "recovered"))
        .resolves.toBe("recovered");
    } finally {
      release?.();
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
