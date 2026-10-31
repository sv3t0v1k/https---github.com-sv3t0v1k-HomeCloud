import { createHash } from "crypto";
import { inflateRawSync } from "zlib";

const REPOSITORY = "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ARCHIVE = 2_000_000;
const MAX_MANIFEST = 1_000_000;

type Installed = { version: string; gitSha: string; schemaMigrations: string[] };
type TestImage = { repository: string; digest: string; platform_digest: string; statement_digest: string; revision: string; version: string };
type TestManifest = {
  format: string; repository: string; commit: string; platform: string;
  images: { backend: TestImage; frontend: TestImage };
  schema_migrations: { name: string; file: string; sha256: string }[];
  source_files: Record<string, string>;
  ci: { run_id: string; attempt: string; workflow: string };
  manifest_sha256: string;
};

export type TestCandidate = { version: string; gitSha: string; backendDigest: string;
  frontendDigest: string; compatibility: "exact-migrations"; changes: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requireValid(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid TEST build evidence");
}

async function request(url: string, token: string): Promise<Response> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return response;
}

async function json(url: string, token: string): Promise<unknown> {
  const response = await request(url, token);
  requireValid(response.ok && response.status < 300 && Number(response.headers.get("content-length") || 0) <= MAX_MANIFEST);
  const text = await response.text();
  requireValid(Buffer.byteLength(text) <= MAX_MANIFEST);
  return JSON.parse(text);
}

async function boundedBytes(response: Response): Promise<Buffer> {
  requireValid(response.ok && response.status === 200 && Number(response.headers.get("content-length") || 0) <= MAX_ARCHIVE && response.body);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValid(size <= MAX_ARCHIVE);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); }
}

// GitHub Actions always downloads a ZIP; accept exactly one unencrypted JSON entry.
function artifactJson(zip: Buffer): unknown {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  requireValid(eocd >= 0 && zip.readUInt16LE(eocd + 10) === 1 && zip.readUInt16LE(eocd + 8) === 1);
  const central = zip.readUInt32LE(eocd + 16);
  requireValid(central + 46 <= eocd && zip.readUInt32LE(central) === 0x02014b50);
  const flags = zip.readUInt16LE(central + 8), method = zip.readUInt16LE(central + 10);
  const compressed = zip.readUInt32LE(central + 20), plain = zip.readUInt32LE(central + 24);
  const nameLength = zip.readUInt16LE(central + 28), extraLength = zip.readUInt16LE(central + 30);
  const commentLength = zip.readUInt16LE(central + 32);
  const local = zip.readUInt32LE(central + 42);
  requireValid((flags & 1) === 0 && (method === 0 || method === 8) &&
    plain <= MAX_MANIFEST && compressed <= MAX_ARCHIVE &&
    central + 46 + nameLength + extraLength + commentLength <= eocd &&
    zip.toString("utf8", central + 46, central + 46 + nameLength) === "test-channel.json" &&
    local + 30 <= central && zip.readUInt32LE(local) === 0x04034b50);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  requireValid(start + compressed <= central);
  const raw = zip.subarray(start, start + compressed);
  const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST }) : raw;
  requireValid(data.length === plain);
  return JSON.parse(data.toString("utf8"));
}

async function downloadArtifact(id: number, token: string): Promise<unknown> {
  requireValid(Number.isSafeInteger(id) && id > 0);
  const response = await request(`${API}/actions/artifacts/${id}/zip`, token);
  requireValid(response.status === 302);
  const location = response.headers.get("location");
  requireValid(location);
  const redirect = new URL(location);
  requireValid(redirect.protocol === "https:" &&
    /^productionresultssa\d+\.blob\.core\.windows\.net$/.test(redirect.hostname));
  // Signed one-minute GitHub artifact URL. Never forward the GitHub credential.
  return artifactJson(await boundedBytes(await fetch(redirect.href, {
    redirect: "manual", signal: AbortSignal.timeout(8000),
  })));
}

function verifiedManifest(raw: unknown, commit: string, runId: number, attempt: number): TestManifest {
  requireValid(raw && typeof raw === "object" && !Array.isArray(raw));
  const value = raw as TestManifest;
  const keys = Object.keys(value).sort().join(",");
  requireValid(keys === "ci,commit,format,images,manifest_sha256,platform,repository,schema_migrations,source_files" &&
    value.format === "homecloud-test-channel-v1" && value.repository === REPOSITORY.toLowerCase() &&
    value.commit === commit && value.platform === "linux/amd64" && SHA.test(value.commit) &&
    value.ci?.run_id === String(runId) && value.ci?.attempt === String(attempt) &&
    value.ci?.workflow === "ci-v2-fast.yml" &&
    value.images && Object.keys(value.images).sort().join(",") === "backend,frontend" &&
    value.source_files && typeof value.source_files === "object" && !Array.isArray(value.source_files) &&
    Object.keys(value.source_files).length > 0 &&
    Object.values(value.source_files).every((x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) &&
    Array.isArray(value.schema_migrations) && value.schema_migrations.length > 0);
  const names = new Set<string>();
  for (const item of value.schema_migrations) {
    requireValid(item && typeof item.name === "string" && /^[A-Za-z0-9]+$/.test(item.name) &&
      typeof item.file === "string" && /^\d+-[A-Za-z0-9]+\.ts$/.test(item.file) &&
      typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) && !names.has(item.name));
    names.add(item.name);
  }
  for (const role of ["backend", "frontend"] as const) {
    const image = value.images[role];
    requireValid(image && Object.keys(image).sort().join(",") ===
      "digest,platform_digest,repository,revision,statement_digest,version" &&
      image.repository === `ghcr.io/${REPOSITORY.toLowerCase()}/${role}` &&
      DIGEST.test(image.digest) && DIGEST.test(image.platform_digest) &&
      DIGEST.test(image.statement_digest) && image.revision === commit && image.version === `test-${commit}`);
  }
  const { manifest_sha256, ...body } = value;
  requireValid(/^[a-f0-9]{64}$/.test(manifest_sha256) &&
    createHash("sha256").update(canonical(body)).digest("hex") === manifest_sha256);
  return value;
}

async function digestExists(role: "backend" | "frontend", digest: string,
  token: string, user: string): Promise<boolean> {
  try {
    const repository = `${REPOSITORY.toLowerCase()}/${role}`;
    const auth: Record<string, string> = token && user ? { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` } : {};
    const issued = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, {
      redirect: "manual", signal: AbortSignal.timeout(4000), headers: auth });
    if (!issued.ok || issued.status !== 200) return false;
    const grant = await issued.json() as { token?: string };
    if (!grant.token || grant.token.length > 10000) return false;
    const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${digest}`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${grant.token}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" } });
    return response.status === 200 && response.headers.get("docker-content-digest") === digest;
  } catch { return false; }
}

export async function discoverTestBuild(installed: Installed, token: string, user: string): Promise<TestCandidate | null> {
  const branch = await json(`${API}/branches/test`, token) as { protected?: boolean; commit?: { sha?: string } };
  const head = branch.commit?.sha;
  requireValid(branch.protected === true && typeof head === "string" && SHA.test(head));
  if (head === installed.gitSha) return null;
  const results = await json(`${API}/actions/runs?branch=test&event=push&head_sha=${head}&per_page=10`, token) as {
    workflow_runs?: { id: number; event: string; path: string; head_sha: string;
      head_branch: string; status: string; conclusion: string; run_attempt: number }[] };
  requireValid(Array.isArray(results.workflow_runs));
  const run = results.workflow_runs.find((item) =>
    item.head_sha === head && item.head_branch === "test" && item.event === "push" &&
    item.path === ".github/workflows/ci-v2-fast.yml" && item.status === "completed" &&
    item.conclusion === "success" && Number.isSafeInteger(item.id) && Number.isSafeInteger(item.run_attempt));
  if (!run) return null;
  const list = await json(`${API}/actions/runs/${run.id}/artifacts?per_page=100`, token) as {
    artifacts?: { id: number; name: string; expired: boolean; workflow_run?: { id: number; head_sha: string } }[] };
  requireValid(Array.isArray(list.artifacts));
  const matching = list.artifacts.filter((a) => a.name === `test-channel-${run.run_attempt}` &&
    a.expired === false && a.workflow_run?.id === run.id && a.workflow_run?.head_sha === head);
  requireValid(matching.length === 1);
  const manifest = verifiedManifest(await downloadArtifact(matching[0].id, token), head, run.id, run.run_attempt);
  const actual = [...manifest.schema_migrations.map((item) => item.name)].sort();
  requireValid(installed.schemaMigrations.length > 0);
  if (JSON.stringify(actual) !== JSON.stringify([...installed.schemaMigrations].sort())) return null;
  const comparison = await json(`${API}/compare/${installed.gitSha}...${head}`, token) as { status?: string };
  if (comparison.status !== "ahead") return null;
  if (!(await digestExists("backend", manifest.images.backend.digest, token, user)) ||
      !(await digestExists("frontend", manifest.images.frontend.digest, token, user)))
    throw new Error("TEST image unavailable");
  return { version: `test-${head.slice(0, 7)}`, gitSha: head,
    backendDigest: manifest.images.backend.digest, frontendDigest: manifest.images.frontend.digest,
    compatibility: "exact-migrations", changes: "" };
}
