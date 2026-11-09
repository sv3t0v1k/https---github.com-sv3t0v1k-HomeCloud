import { ServiceUnavailableException } from "@nestjs/common";
import { PreviewsService } from "./previews.service";

describe("Thumbnail PostgreSQL timeout protection", () => {
  it.each([
    {
      name: "lock timeout",
      error: { code: "55P03" },
    },
    {
      name: "statement timeout through TypeORM",
      error: { driverError: { code: "57014" } },
    },
  ])("bounds database work and maps $name to 503", async ({ error }) => {
    const query = jest.fn(async (sql: string) => {
      if (sql === "SELECT id FROM users WHERE id=$1 FOR SHARE") {
        throw error;
      }
      return [];
    });

    const manager = {
      query,
      findOne: jest.fn(),
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
      {} as never,
    );

    await expect(service.getThumbnail(7, 5))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SET LOCAL lock_timeout = '1500ms'",
      "SET LOCAL statement_timeout = '2500ms'",
      "SELECT id FROM users WHERE id=$1 FOR SHARE",
    ]);

    expect(manager.findOne).not.toHaveBeenCalled();

    const state = service as unknown as {
      activeThumbnails: number;
    };
    expect(state.activeThumbnails).toBe(0);
  });
});
