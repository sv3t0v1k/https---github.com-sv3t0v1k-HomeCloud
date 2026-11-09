import { ServiceUnavailableException } from "@nestjs/common";
import sharp from "sharp";
import { PreviewsService } from "./previews.service";

jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ThumbnailReader = {
  readAuthorizedThumbnail(
    userId: number,
    fileId: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
};

describe("Thumbnail cancellation across processing stages", () => {
  const sharpMock = sharp as unknown as jest.Mock;

  beforeEach(() => {
    sharpMock.mockReset();
  });

  it("does not release an active slot before Sharp settles", async () => {
    const service = new PreviewsService({} as never, {} as never);
    const reader = service as unknown as ThumbnailReader;

    jest.spyOn(reader, "readAuthorizedThumbnail")
      .mockResolvedValue(Buffer.from("source-image"));

    const decode = deferred<Buffer>();
    const bothStarted = deferred<void>();
    let decodeCalls = 0;

    sharpMock.mockImplementation(() => ({
      rotate: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      png: jest.fn().mockReturnThis(),
      timeout: jest.fn().mockReturnThis(),
      toBuffer: jest.fn(() => {
        decodeCalls += 1;
        if (decodeCalls === 2) bothStarted.resolve();
        return decode.promise;
      }),
    }));

    const controller = new AbortController();
    const first = service.getThumbnail(1, 1, controller.signal);
    const second = service.getThumbnail(1, 2);

    const firstAssertion = (async () => {
      await expect(first)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();
    const secondAssertion = (async () => {
      await expect(second)
        .resolves.toEqual(Buffer.from("thumbnail"));
    })();

    await bothStarted.promise;

    const third = service.getThumbnail(1, 3);
    const thirdAssertion = (async () => {
      await expect(third)
        .resolves.toEqual(Buffer.from("thumbnail"));
    })();

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    // The first decode is still running. No replacement may start.
    expect(decodeCalls).toBe(2);

    decode.resolve(Buffer.from("thumbnail"));

    await firstAssertion;
    await secondAssertion;
    await thirdAssertion;

    expect(decodeCalls).toBe(3);
    await expect(service.getThumbnail(1, 4))
      .resolves.toEqual(Buffer.from("thumbnail"));
  });

  it("does not start Sharp after cancellation during file reading", async () => {
    const service = new PreviewsService({} as never, {} as never);
    const reader = service as unknown as ThumbnailReader;

    const readStarted = deferred<void>();
    const fileBytes = deferred<Buffer>();

    jest.spyOn(reader, "readAuthorizedThumbnail")
      .mockImplementation(async () => {
        readStarted.resolve();
        return fileBytes.promise;
      });

    const controller = new AbortController();
    const job = service.getThumbnail(1, 1, controller.signal);
    const assertion = (async () => {
      await expect(job)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    await readStarted.promise;
    controller.abort();
    fileBytes.resolve(Buffer.from("source-image"));

    await assertion;
    expect(sharpMock).not.toHaveBeenCalled();
  });
});
