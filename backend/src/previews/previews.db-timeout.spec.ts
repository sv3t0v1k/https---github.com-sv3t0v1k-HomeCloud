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
      if (sql === 'SELECT id FROM users WHERE id=$1 AND "isActive"=TRUE FOR SHARE') {
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
      'SELECT id FROM users WHERE id=$1 AND "isActive"=TRUE FOR SHARE',
    ]);

    expect(manager.findOne).not.toHaveBeenCalled();

    const state = service as unknown as {
      activeThumbnails: number;
    };
    expect(state.activeThumbnails).toBe(0);
  });
  it("cancels only its own active PostgreSQL session on abort", async () => {
    let unblock!: (error: unknown) => void;
    let reached!: () => void;

    const blocked = new Promise<unknown[]>((_resolve, reject) => {
      unblock = reject;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });

    let marker = "";

    const query = jest.fn(async (
      sql: string,
      params?: unknown[],
    ): Promise<unknown[]> => {
      if (sql.startsWith("SET LOCAL ")) return [];

      if (sql.includes("SELECT pg_backend_pid()")) {
        marker = String(params?.[0]);
        return [{ pid: 4321, marker }];
      }

      if (sql.includes("SELECT id FROM users WHERE")) {
        reached();
        return blocked;
      }

      throw new Error(`Unexpected transaction SQL: ${sql}`);
    });

    const cancel = jest.fn(async (
      sql: string,
      params?: unknown[],
    ) => {
      expect(sql).toContain("pg_cancel_backend(pid)");
      expect(sql).toContain("application_name = $2");
      expect(sql).toContain("usename = current_user");
      expect(sql).toContain("state = 'active'");
      expect(params).toEqual([4321, marker]);

      unblock(Object.assign(
        new Error("query cancelled"),
        { code: "57014" },
      ));

      return [{ cancelled: true }];
    });

    const manager = { query, findOne: jest.fn() };
    const repository = {
      manager: {
        transaction: async (
          callback: (value: typeof manager) => Promise<unknown>,
        ) => callback(manager),
        query: cancel,
      },
    };

    const service = new PreviewsService(
      repository as never,
      {} as never,
    );
    const controller = new AbortController();

    const pending = service.getThumbnail(
      7, 5, controller.signal,
    );
    const assertion = (async () => {
      await expect(pending)
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    })();

    await entered;
    controller.abort();
    await assertion;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(manager.findOne).not.toHaveBeenCalled();

    const state = service as unknown as {
      activeThumbnails: number;
    };
    expect(state.activeThumbnails).toBe(0);
  });


  it.each([
    { name: "lock timeout", error: { code: "55P03" } },
    {
      name: "statement timeout",
      error: { driverError: { code: "57014" } },
    },
  ])("bounds full preview SQL: $name", async ({ error }) => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith("SET LOCAL ")) return [];
      if (sql === 'SELECT id FROM users WHERE id=$1 AND "isActive"=TRUE FOR SHARE') {
        throw error;
      }
      throw new Error("Unexpected SQL");
    });

    const manager = { query, findOne: jest.fn() };
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

    await expect(service.getPreview(7, 5))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SET LOCAL lock_timeout = '1500ms'",
      "SET LOCAL statement_timeout = '2500ms'",
      'SELECT id FROM users WHERE id=$1 AND "isActive"=TRUE FOR SHARE',
    ]);
    expect(manager.findOne).not.toHaveBeenCalled();
  });

});
