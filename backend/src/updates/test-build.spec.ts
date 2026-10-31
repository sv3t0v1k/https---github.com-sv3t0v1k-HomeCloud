import { createHash } from "crypto";
import { deflateRawSync } from "zlib";
import { discoverTestBuild } from "./test-build";

const repo = "sv3t0v1k/https---github.com-sv3t0v1k-homecloud";
const oldSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const backend = `sha256:${"1".repeat(64)}`;
const frontend = `sha256:${"2".repeat(64)}`;
const digestProof = `sha256:${"3".repeat(64)}`;
const artifactId = 52;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function manifest() {
  const image = (role: "backend" | "frontend") => ({
    repository: `ghcr.io/${repo}/${role}`, digest: role === "backend" ? backend : frontend,
    platform_digest: digestProof, statement_digest: digestProof,
    revision: nextSha, version: `test-${nextSha}`,
  });
  const body = {
    format: "homecloud-test-channel-v1", repository: repo, commit: nextSha,
    platform: "linux/amd64", images: { backend: image("backend"), frontend: image("frontend") },
    schema_migrations: [{ name: "MigrationOne", file: "123-MigrationOne.ts", sha256: "4".repeat(64) }],
    source_files: { "backend/Dockerfile": "5".repeat(64) },
    ci: { run_id: "123", attempt: "1", workflow: "ci-v2-fast.yml" },
  };
  return { ...body, manifest_sha256: createHash("sha256").update(canonical(body)).digest("hex") };
}

// In-memory single-entry Actions ZIP: central-directory sizes are authoritative.
function zipManifest(json: unknown): Buffer {
  const name = Buffer.from("test-channel.json");
  const data = Buffer.from(JSON.stringify(json));
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, directory, eocd]);
}

describe("TEST channel read-only discovery", () => {
  let original: typeof fetch;
  let current = manifest();
  let branchProtected = true;
  let archive: Buffer;
  const installed = { version: oldSha.slice(0, 7), gitSha: oldSha, schemaMigrations: ["MigrationOne"] };
  beforeEach(() => {
    original = global.fetch;
    current = manifest();
    branchProtected = true;
    archive = zipManifest(current);
    global.fetch = jest.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/branches/test")) return Response.json({ protected: branchProtected, commit: { sha: nextSha } });
      if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: [{ id: 123,
        head_sha: nextSha, head_branch: "test", event: "push", status: "completed", conclusion: "success",
        path: ".github/workflows/ci-v2-fast.yml", run_attempt: 1 }] });
      if (url.endsWith("/actions/runs/123/artifacts?per_page=100")) return Response.json({ artifacts: [{
        id: artifactId, name: "test-channel-1", expired: false, workflow_run: { id: 123, head_sha: nextSha },
      }] });
      if (url.endsWith(`/actions/artifacts/${artifactId}/zip`)) return new Response(null, {
        status: 302, headers: { location: "https://productionresultssa30.blob.core.windows.net/result?sig=sample" },
      });
      if (url.startsWith("https://productionresultssa30.blob.core.windows.net/")) {
        expect(init?.headers).toBeUndefined(); // GitHub token must not cross origin.
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      if (url.includes("/compare/")) return Response.json({ status: "ahead" });
      if (url.includes("ghcr.io/token")) return Response.json({ token: "registry-token" });
      if (url.includes("ghcr.io/v2/")) return new Response(null, { status: 200,
        headers: { "docker-content-digest": url.endsWith(backend) ? backend : frontend } });
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;
  });
  afterEach(() => { global.fetch = original; });

  it("returns only a verified TEST manifest and exact registry pair", async () => {
    expect(await discoverTestBuild(installed, "read-only", "")).toEqual({
      version: `test-${nextSha.slice(0, 7)}`, gitSha: nextSha, backendDigest: backend,
      frontendDigest: frontend, changes: "", compatibility: "exact-migrations",
    });
  });
  it("refuses an unprotected test branch", async () => {
    branchProtected = false;
    await expect(discoverTestBuild(installed, "read-only", "")).rejects.toThrow("Invalid TEST");
  });
  it("rejects a modified manifest checksum", async () => {
    current.images.backend.digest = `sha256:${"6".repeat(64)}`;
    archive = zipManifest(current);
    await expect(discoverTestBuild(installed, "read-only", "")).rejects.toThrow("Invalid TEST");
  });
  it("never suggests a schema-incompatible TEST build", async () => {
    expect(await discoverTestBuild({ ...installed, schemaMigrations: ["AnotherMigration"] }, "read-only", "")).toBeNull();
  });
  it("rejects corrupt artifact data without announcing an update", async () => {
    archive = Buffer.from("not a zip");
    await expect(discoverTestBuild(installed, "read-only", "")).rejects.toThrow("Invalid TEST");
  });
  it("does not advertise the installed commit as an update", async () => {
    expect(await discoverTestBuild({ ...installed, gitSha: nextSha }, "read-only", "")).toBeNull();
  });
  it("does not accept a mismatched GHCR digest", async () => {
    const upstream = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("ghcr.io/v2/"))
        return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "9".repeat(64) } });
      return upstream(url, init);
    }) as typeof fetch;
    await expect(discoverTestBuild(installed, "read-only", "")).rejects.toThrow("TEST image unavailable");
  });
});
