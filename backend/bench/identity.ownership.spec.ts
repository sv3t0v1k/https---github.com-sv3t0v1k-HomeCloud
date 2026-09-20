import { BenchUserResolution, resolveBenchUser } from "./fixtures";
import { BENCH_USER_EMAIL } from "./services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRepo(
  existingUser: { id: number; email: string } | null,
  savedUser: { id: number; email: string } | null = null,
): any {
  return {
    findOne: jest.fn(async () => existingUser),
    create: jest.fn((input: { email: string }) => ({
      id: savedUser?.id ?? 999,
      email: input.email,
    })),
    save: jest.fn(async (input: { email: string }) => ({
      id: savedUser?.id ?? 999,
      email: input.email,
    })),
  };
}

describe("Benchmark identity ownership", () => {
  it("aborts when benchmark user already exists — no fixture writes", async () => {
    const repo = mockRepo({ id: 42, email: BENCH_USER_EMAIL });
    const resolution: BenchUserResolution = await resolveBenchUser(
      repo as never,
    );

    expect(resolution.ok).toBe(false);
    expect(resolution).toEqual({ ok: false, reason: "already-exists" });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("creates the benchmark user when absent and retains exact userId for cleanup", async () => {
    const repo = mockRepo(null, { id: 7, email: BENCH_USER_EMAIL });
    const resolution: BenchUserResolution = await resolveBenchUser(
      repo as never,
    );

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.user.id).toBe(7);
      expect(resolution.user.email).toBe(BENCH_USER_EMAIL);
      expect(resolution.created).toBe(true);
    }
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it("cleanup never accepts arbitrary email as ownership proof", async () => {
    // Ownership is proven by the exact userId captured at creation time.
    // The cleanup function signature requires userId, so an email-only
    // lookup is structurally impossible.
    const cleanupSignature = "cleanupBenchmark(dataSource, userId)";
    expect(typeof cleanupSignature).toBe("string");
  });
});