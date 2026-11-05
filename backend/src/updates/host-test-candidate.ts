import { constants } from "fs";
import { open } from "fs/promises";
import { isAbsolute } from "path";
import { TestCandidate } from "./test-build";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

type Installed = { gitSha: string; schemaMigrations: string[] };
type CandidateRecord = {
  format: string; checkedAt: number; verifiedAt: number; sourceGitSha: string;
  commit: string; manifestSha256: string; backendDigest: string;
  frontendDigest: string; schemaMigrations: string[];
  runId: number; attempt: number; artifactId: number;
};

export function parseHostTestCandidate(raw: unknown, installed: Installed, now = Date.now()): TestCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid host candidate");
  const value = raw as CandidateRecord;
  if (Object.keys(value).sort().join(",") !==
      "artifactId,attempt,backendDigest,checkedAt,commit,format,frontendDigest,manifestSha256,runId,schemaMigrations,sourceGitSha,verifiedAt" ||
      value.format !== "homecloud-host-test-candidate-v1" ||
      !Number.isSafeInteger(value.checkedAt) || !Number.isSafeInteger(value.verifiedAt) ||
      value.checkedAt < Math.floor(now / 1000) - 600 || value.checkedAt > Math.floor(now / 1000) + 30 ||
      value.verifiedAt > value.checkedAt || value.verifiedAt < Math.floor(now / 1000) - 43200 ||
      !SHA.test(value.sourceGitSha) ||
      !SHA.test(value.commit) || !HASH.test(value.manifestSha256) ||
      !DIGEST.test(value.backendDigest) || !DIGEST.test(value.frontendDigest) ||
      !Number.isSafeInteger(value.runId) || value.runId < 1 ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 ||
      !Number.isSafeInteger(value.artifactId) || value.artifactId < 1 ||
      !Array.isArray(value.schemaMigrations) || value.schemaMigrations.length === 0 ||
      value.schemaMigrations.some((name) => typeof name !== "string" || !/^[A-Za-z0-9]+$/.test(name)) ||
      new Set(value.schemaMigrations).size !== value.schemaMigrations.length ||
      JSON.stringify([...value.schemaMigrations].sort()) !== JSON.stringify([...installed.schemaMigrations].sort())) {
    throw new Error("Unverified host candidate");
  }
  if (value.commit === installed.gitSha) return null;
  if (value.sourceGitSha !== installed.gitSha) throw new Error("Candidate source differs from installed TEST version");
  return { version: `test-${value.commit.slice(0, 7)}`, gitSha: value.commit,
    backendDigest: value.backendDigest, frontendDigest: value.frontendDigest,
    manifestSha256: value.manifestSha256, compatibility: "exact-migrations", changes: "" };
}

export async function readHostTestCandidate(path: string, installed: Installed): Promise<TestCandidate | null> {
  if (!isAbsolute(path)) throw new Error("Invalid host candidate path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || info.gid !== 65533 ||
        (info.mode & 0o777) !== 0o640 || info.nlink !== 1 ||
        info.size < 1 || info.size > 4096) throw new Error("Unsafe host candidate file");
    const bytes = await handle.readFile();
    if (bytes.length > 4096) throw new Error("Oversized host candidate file");
    return parseHostTestCandidate(JSON.parse(bytes.toString("utf8")), installed);
  } finally {
    await handle.close();
  }
}
