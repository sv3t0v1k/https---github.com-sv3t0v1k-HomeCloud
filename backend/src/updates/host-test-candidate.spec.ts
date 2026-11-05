import { parseHostTestCandidate } from "./host-test-candidate";

const installed = { gitSha: "a".repeat(40), schemaMigrations: ["First1", "Second2"] };
const now = 1_800_000_000_000;
const candidate = {
  format: "homecloud-host-test-candidate-v1",
  checkedAt: now / 1000 - 30,
  verifiedAt: now / 1000 - 120,
  sourceGitSha: installed.gitSha,
  commit: "b".repeat(40),
  manifestSha256: "c".repeat(64),
  backendDigest: `sha256:${"d".repeat(64)}`,
  frontendDigest: `sha256:${"e".repeat(64)}`,
  schemaMigrations: ["Second2", "First1"],
  runId: 12, attempt: 1, artifactId: 34,
};

describe("root-owned TEST candidate contract", () => {
  it("exposes a verified compatible candidate and reports current after installation", () => {
    expect(parseHostTestCandidate(candidate, installed, now)?.gitSha).toBe(candidate.commit);
    expect(parseHostTestCandidate({ ...candidate, commit: installed.gitSha }, installed, now)).toBeNull();
    expect(parseHostTestCandidate(candidate,
      { gitSha: candidate.commit, schemaMigrations: installed.schemaMigrations }, now)).toBeNull();
  });

  it("refuses stale, mismatched, malformed and expanded host data", () => {
    for (const bad of [
      { ...candidate, checkedAt: now / 1000 - 601 },
      { ...candidate, verifiedAt: now / 1000 - 43201 },
      { ...candidate, sourceGitSha: "f".repeat(40) },
      { ...candidate, schemaMigrations: ["First1", "Unexpected3"] },
      { ...candidate, manifestSha256: "invalid" },
      { ...candidate, extra: "field" },
    ]) {
      expect(() => parseHostTestCandidate(bad, installed, now)).toThrow();
    }
  });
});
