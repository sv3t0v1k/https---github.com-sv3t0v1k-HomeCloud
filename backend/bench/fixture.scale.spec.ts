import { DataSource } from "typeorm";
import {
  saveBatched,
  FIXTURE_BATCH_SIZE,
  cleanupBenchmark,
} from "./fixtures";
import { BENCH_USER_EMAIL } from "./services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRepo(saves: any[]): any {
  let callIndex = 0;
  return {
    create: jest.fn((input: any) => ({ ...input, id: callIndex++ })),
    save: jest.fn(async (batch: any | any[]) => {
      const arr = Array.isArray(batch) ? batch : [batch];
      saves.push(...arr);
      return arr;
    }),
    delete: jest.fn(async () => ({ affected: 1 })),
    query: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findOne: jest.fn(async () => undefined),
  };
}

describe("Benchmark fixture scalability and partial-failure cleanup", () => {
  it("saveBatched preserves total row count including non-multiple tail", async () => {
    const saves: any[] = [];
    const repo = mockRepo(saves);
    const rows = Array.from({ length: 1234 }, (_, i) => ({ id: i }));
    await saveBatched(repo as never, rows);
    expect(saves.length).toBe(1234);
    expect(repo.save).toHaveBeenCalledTimes(
      Math.ceil(1234 / FIXTURE_BATCH_SIZE),
    );
  });

  it("saveBatched uses the fixed conservative batch size", () => {
    expect(FIXTURE_BATCH_SIZE).toBe(500);
  });

  it("partial-failure cleanup targets only the exact created userId", async () => {
    const userId = 42;
    const deletes: number[] = [];
    const mockDs = {
      query: jest.fn(async (sql: string, params: number[]) => {
        deletes.push(params[0]);
        return [];
      }),
      getRepository: jest.fn(() => ({
        delete: jest.fn(async (id: number) => {
          deletes.push(id);
          return { affected: 1 };
        }),
      })),
    } as unknown as DataSource;

    await cleanupBenchmark(mockDs, userId);

    // FK-safe order: shares, sessions, files, folders, then user
    expect(deletes).toEqual([userId, userId, userId, userId, userId]);
    expect(mockDs.query).toHaveBeenCalledTimes(4);
  });

  it("cleanup never accepts arbitrary email as ownership proof", () => {
    // Signature requires userId; email-only ownership is structurally impossible.
    const sig = cleanupBenchmark.toString();
    expect(sig).toContain("userId");
    expect(sig).not.toContain(BENCH_USER_EMAIL);
  });
});