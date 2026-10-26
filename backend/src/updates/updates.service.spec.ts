import { createHash } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ConfigService } from "@nestjs/config";
import { UpdatesService, verifiedLock } from "./updates.service";

const repo = "sv3t0v1k/https---github.com-sv3t0v1k-homecloud";
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);
const digest = `sha256:${"c".repeat(64)}`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function lock(commit: string, tag: string) {
  const image = (role: string) => ({ repository: `ghcr.io/${repo}/${role}`, digest, revision: commit, version: tag,
    platform: "linux/amd64", provenance_verification: { index_digest: digest, verified: "DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS" } });
  const body = { format: "homecloud-ci-candidate-v1", repository: repo, tag, tag_object: "d".repeat(40), commit,
    deployment_status: "NOT_DEPLOYED", schema_migrations: ["MigrationOne"],
    ci: { status: "success", run_id: "123", attempt: "1", url: `https://github.com/${repo}/actions/runs/123` },
    production_qualification: { format: "homecloud-production-qualification-v2", status: "PASS", coverage: "COVERED",
      qualification_profile: "release", source_commit: commit, ci: { run_id: "123", attempt: "1" } },
    images: { backend: image("backend"), frontend: image("frontend") } };
  return { ...body, manifest_sha256: createHash("sha256").update(canonical(body)).digest("hex") };
}

describe("updates discovery", () => {
  let directory: string;
  let originalFetch: typeof fetch;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "homecloud-updates-")); originalFetch = global.fetch; });
  afterEach(async () => { global.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });

  it("rejects a changed digest and incomplete qualification", () => {
    const value = lock(newSha, "v0.9.1-beta.1");
    value.images.backend.digest = `sha256:${"e".repeat(64)}`;
    expect(verifiedLock(value)).toBeNull();
    const weak = lock(newSha, "v0.9.1-beta.1");
    weak.production_qualification.status = "FAIL";
    expect(verifiedLock(weak)).toBeNull();
  });

  it("shows a configured operator snapshot for a pre-beta test installation", async () => {
    await writeFile(join(directory, "snapshot.json"), JSON.stringify({
      format: "homecloud-installed-test-v1", version: oldSha.slice(0, 7), gitSha: oldSha,
      schemaMigrations: ["MigrationOne"],
    }));
    const service = new UpdatesService({ get: (key: string) => key === "UPDATE_INSTALLED_METADATA_PATH" ? join(directory, "snapshot.json") : "" } as ConfigService);
    global.fetch = jest.fn(async () => Response.json([])) as typeof fetch;
    expect(await service.check()).toMatchObject({
      installed: { version: oldSha.slice(0, 7), gitSha: oldSha }, status: "current", available: null,
    });
  });

  it("hides releases that are drafts or lack current registry digests", async () => {
    const installed = lock(oldSha, "v0.9.0-beta.1");
    await writeFile(join(directory, "installed.json"), JSON.stringify(installed));
    const config = { get: (key: string) => key === "UPDATE_INSTALLED_LOCK_PATH" ? join(directory, "installed.json") : key === "UPDATE_ADMIN_USER_ID" ? "7" : "" } as ConfigService;
    const service = new UpdatesService(config);
    expect(service.isAdmin(7)).toBe(true);
    expect(service.isAdmin(8)).toBe(false);
    let draft = true;
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/releases?")) return Response.json([{ draft, prerelease: true, tag_name: "v0.9.1-beta.1", body: "## Изменения\nИсправлена загрузка.", assets: [{ name: "release-lock.json", url: `https://api.github.com/repos/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/releases/assets/42` }] }]);
      if (url.includes("/releases/assets/42")) return Response.json(lock(newSha, "v0.9.1-beta.1"));
      if (url.includes("/compare/")) return Response.json({ status: "ahead" });
      if (url.includes("/actions/runs/123")) return Response.json({ conclusion: "success", head_sha: newSha, event: "workflow_dispatch", path: ".github/workflows/release.yml", run_attempt: 1 });
      if (url.includes("/git/ref/tags/")) return Response.json({ object: { type: "tag", sha: "d".repeat(40) } });
      if (url.includes("/git/tags/")) return Response.json({ object: { type: "commit", sha: newSha } });
      if (url.includes("ghcr.io/token")) return Response.json({ token: "registry-token" });
      if (url.includes("ghcr.io/v2/")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    expect((await service.check()).available).toBeNull();
    draft = false;
    expect((await service.check()).available).toBeNull();
    expect((await service.check()).status).toBe("current");
  });

  it("reports only a published, qualified and retrievable pair", async () => {
    await writeFile(join(directory, "installed.json"), JSON.stringify(lock(oldSha, "v0.9.0-beta.1")));
    const service = new UpdatesService({ get: (key: string) => key === "UPDATE_INSTALLED_LOCK_PATH" ? join(directory, "installed.json") : "" } as ConfigService);
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/releases?")) return Response.json([{ draft: false, prerelease: true, tag_name: "v0.9.1-beta.1", body: "## Изменения\nИсправлена загрузка.", assets: [{ name: "release-lock.json", url: `https://api.github.com/repos/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/releases/assets/42` }] }]);
      if (url.includes("/releases/assets/42")) return Response.json(lock(newSha, "v0.9.1-beta.1"));
      if (url.includes("/compare/")) return Response.json({ status: "ahead" });
      if (url.includes("/actions/runs/123")) return Response.json({ conclusion: "success", head_sha: newSha, event: "workflow_dispatch", path: ".github/workflows/release.yml", run_attempt: 1 });
      if (url.includes("/git/ref/tags/")) return Response.json({ object: { type: "tag", sha: "d".repeat(40) } });
      if (url.includes("/git/tags/")) return Response.json({ object: { type: "commit", sha: newSha } });
      if (url.includes("ghcr.io/token")) return Response.json({ token: "registry-token" });
      if (url.includes("ghcr.io/v2/")) return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const result = await service.check();
    expect(result.status).toBe("available");
    expect(result.available).toMatchObject({ version: "v0.9.1-beta.1", gitSha: newSha, backendDigest: digest, frontendDigest: digest, changes: "Исправлена загрузка." });
  });
});
