import { ServiceUnavailableException } from "@nestjs/common";
import { FileEntity } from "../entities/file.entity";
import { PreviewsService } from "./previews.service";

type Reader = {
  activeThumbnails: number;
  readSecurePreviewBytes(
    filePath: string,
    isText: boolean,
    signal?: AbortSignal,
  ): Promise<{ data: Buffer; truncated: boolean }>;
};

function fixture() {
  const file = {
    id: 5,
    userId: 7,
    isDeleted: false,
    isFolder: false,
    parentId: null,
    mimeType: "text/plain",
    storagePath: "/approved/preview.txt",
  } as FileEntity;

  const manager = {
    query: jest.fn(async (sql: string) => {
      if (sql.startsWith("SET LOCAL ")) return [];
      if (sql.includes("SELECT id FROM users")) return [{ id: 7 }];
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    findOne: jest.fn(async () => file),
  };

  const repository = {
    manager: {
      transaction: async (
        callback: (value: typeof manager) => Promise<unknown>,
      ) => callback(manager),
    },
  };

  const service = new PreviewsService(
    repository as never,
    { resolveFilePath: () => file.storagePath } as never,
  );

  return { service, reader: service as unknown as Reader };
}

describe("Ordinary preview cancellation and bounded capacity", () => {
  it("retains a slot until cancelled IO settles", async () => {
    const { service, reader } = fixture();
    const controller = new AbortController();

    const releases: Array<() => void> = [];

    let started = 0;
    let secondStarted!: () => void;
    let thirdStarted!: () => void;

    const two = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const three = new Promise<void>((resolve) => {
      thirdStarted = resolve;
    });

    jest.spyOn(reader, "readSecurePreviewBytes")
      .mockImplementation(() => new Promise((resolve) => {
        started += 1;
        releases.push(() => resolve({
          data: Buffer.from("preview"),
          truncated: false,
        }));

        if (started === 2) secondStarted();
        if (started === 3) thirdStarted();
      }));

    const first = service.getPreview(7, 5, controller.signal);
    const firstAssertion = (async () => {
      await expect(first)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    const second = service.getPreview(7, 5);
    await two;

    const third = service.getPreview(7, 5);

    controller.abort();
    await Promise.resolve();

    expect(started).toBe(2);
    expect(reader.activeThumbnails).toBe(2);

    releases[0]();

    await firstAssertion;
    await three;

    expect(started).toBe(3);
    expect(reader.activeThumbnails).toBe(2);

    releases[1]();
    releases[2]();

    await expect(second).resolves.toMatchObject({
      type: "text",
      content: "preview",
    });

    await expect(third).resolves.toMatchObject({
      type: "text",
      content: "preview",
    });

    expect(reader.activeThumbnails).toBe(0);
  });

  it("aborts after deadline without freeing an active IO slot", async () => {
    jest.useFakeTimers();

    try {
      const { service, reader } = fixture();

      let release!: () => void;
      let entered!: () => void;
      let observedSignal: AbortSignal | undefined;

      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });

      jest.spyOn(reader, "readSecurePreviewBytes")
        .mockImplementation((_file, _text, signal) => {
          observedSignal = signal;
          entered();

          return new Promise((resolve) => {
            release = () => resolve({
              data: Buffer.from("late"),
              truncated: false,
            });
          });
        });

      const work = service.getPreview(7, 5);
      const assertion = (async () => {
        await expect(work)
          .rejects.toBeInstanceOf(ServiceUnavailableException);
      })();

      await started;
      await jest.advanceTimersByTimeAsync(10_001);

      expect(observedSignal?.aborted).toBe(true);
      expect(reader.activeThumbnails).toBe(1);

      release();
      await assertion;

      expect(reader.activeThumbnails).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
