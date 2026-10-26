import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { readFile } from "fs/promises";

const REPOSITORY = "sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^v0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;

type Image = { repository: string; digest: string; revision: string; version: string; platform: string; provenance_verification: { index_digest: string; verified: string } };
type Lock = { format: string; repository: string; tag: string; tag_object: string; commit: string; manifest_sha256: string; deployment_status: string; schema_migrations: string[]; ci: { status: string; run_id: string; attempt: string; url: string }; production_qualification: { format: string; status: string; coverage: string; qualification_profile: string; source_commit: string; ci: { run_id: string; attempt: string } }; images: { backend: Image; frontend: Image } };
type Release = { draft: boolean; prerelease: boolean; tag_name: string; body: string | null; assets: { name: string; url: string }[] };
type Installed = { version: string; gitSha: string; schemaMigrations: string[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${asciiJson(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return asciiJson(value);
}

function asciiJson(value: unknown): string {
  const json = JSON.stringify(value);
  let ascii = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    ascii += code > 127 ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return ascii;
}

export function verifiedLock(value: unknown): Lock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lock = value as Lock;
  try {
    if (lock.format !== "homecloud-ci-candidate-v1" || lock.repository !== REPOSITORY.toLowerCase() ||
        !VERSION.test(lock.tag) || !SHA.test(lock.commit) || !SHA.test(lock.tag_object) || lock.deployment_status !== "NOT_DEPLOYED" ||
        lock.ci.status !== "success" || !/^\d+$/.test(lock.ci.run_id) || !/^\d+$/.test(lock.ci.attempt) ||
        lock.ci.url !== `https://github.com/${lock.repository}/actions/runs/${lock.ci.run_id}` ||
        lock.production_qualification.format !== "homecloud-production-qualification-v2" ||
        lock.production_qualification.status !== "PASS" || lock.production_qualification.coverage !== "COVERED" ||
        lock.production_qualification.qualification_profile !== "release" ||
        lock.production_qualification.source_commit !== lock.commit ||
        lock.production_qualification.ci.run_id !== lock.ci.run_id ||
        lock.production_qualification.ci.attempt !== lock.ci.attempt ||
        !Array.isArray(lock.schema_migrations) || !lock.schema_migrations.length ||
        new Set(lock.schema_migrations).size !== lock.schema_migrations.length ||
        lock.schema_migrations.some((item) => typeof item !== "string" || !/^[A-Za-z0-9]+$/.test(item))) return null;
    for (const role of ["backend", "frontend"] as const) {
      const image = lock.images[role];
      if (image.repository !== `ghcr.io/${lock.repository}/${role}` || !DIGEST.test(image.digest) ||
          image.revision !== lock.commit || image.version !== lock.tag || image.platform !== "linux/amd64" ||
          image.provenance_verification.index_digest !== image.digest ||
          image.provenance_verification.verified !== "DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS") return null;
    }
    const { manifest_sha256, ...body } = lock;
    if (manifest_sha256 !== createHash("sha256").update(canonical(body)).digest("hex")) return null;
    return lock;
  } catch { return null; }
}

async function githubJson(url: string, token: string, accept = "application/vnd.github+json"): Promise<unknown> {
  let response = await fetch(url, {
    headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(4000),
  });
  if (response.status === 302 && accept === "application/octet-stream") {
    const location = response.headers.get("location");
    if (!location || new URL(location).protocol !== "https:" || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(new URL(location).hostname)) throw new Error("Unexpected asset redirect");
    response = await fetch(location, { redirect: "manual", signal: AbortSignal.timeout(4000) });
  }
  if (!response.ok || response.status >= 300 || Number(response.headers.get("content-length") || 0) > 2_000_000) throw new Error("GitHub unavailable");
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("GitHub response too large");
  return JSON.parse(body);
}

async function registryDigest(lock: Lock, role: "backend" | "frontend", token: string, user: string): Promise<boolean> {
  try {
    const scope = `repository:${lock.repository}/${role}:pull`;
    const auth: Record<string, string> = token && user ? { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` } : {};
    const issued = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`, {
      headers: auth, redirect: "manual", signal: AbortSignal.timeout(4000),
    });
    if (!issued.ok || Number(issued.headers.get("content-length") || 0) > 10_000) return false;
    const grant = await issued.json() as { token?: string };
    if (typeof grant.token !== "string" || grant.token.length > 10_000) return false;
    const digest = lock.images[role].digest;
    const response = await fetch(`https://ghcr.io/v2/${lock.repository}/${role}/manifests/${digest}`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${grant.token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" },
    });
    return response.status === 200 && response.headers.get("docker-content-digest") === digest;
  } catch { return false; }
}

function newer(candidate: string, installed: string): boolean {
  const a = VERSION.exec(candidate)?.slice(1).map(Number);
  const b = VERSION.exec(installed)?.slice(1).map(Number);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

@Injectable()
export class UpdatesService {
  constructor(private readonly config: ConfigService) {}

  isAdmin(userId: number): boolean {
    const id = this.config.get<string>("UPDATE_ADMIN_USER_ID");
    return !!id && /^[1-9]\d*$/.test(id) && Number(id) === userId;
  }

  async check() {
    const path = this.config.get<string>("UPDATE_INSTALLED_LOCK_PATH");
    let installed: Installed | null = null;
    try {
      const lock = path && verifiedLock(JSON.parse(await readFile(path, "utf8")));
      if (lock) installed = { version: lock.tag, gitSha: lock.commit, schemaMigrations: lock.schema_migrations };
    } catch { /* Missing deployment evidence remains unknown. */ }
    try {
      const metadataPath = this.config.get<string>("UPDATE_INSTALLED_METADATA_PATH");
      if (!installed && metadataPath) {
        const value = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
        if (value.format === "homecloud-installed-test-v1" && typeof value.gitSha === "string" && SHA.test(value.gitSha) &&
            value.version === value.gitSha.slice(0, 7) && Array.isArray(value.schemaMigrations) && value.schemaMigrations.length > 0 &&
            value.schemaMigrations.every((item) => typeof item === "string" && /^[A-Za-z0-9]+$/.test(item)) &&
            new Set(value.schemaMigrations).size === value.schemaMigrations.length) {
          installed = value as Installed;
        }
      }
    } catch { /* Missing deployment evidence remains unknown. */ }
    const base = { channel: "test", installed: installed ? { version: installed.version, gitSha: installed.gitSha } : null };
    if (!installed) return { ...base, available: null, status: "installed_unknown" };
    try {
      const token = this.config.get<string>("UPDATE_GITHUB_TOKEN") || "";
      const releases = await githubJson(`${API}/releases?per_page=20`, token) as Release[];
      if (!Array.isArray(releases)) throw new Error("Invalid releases");
      for (const release of releases) {
        if (release.draft || !release.prerelease || !VERSION.test(release.tag_name) ||
            (VERSION.test(installed.version) && !newer(release.tag_name, installed.version))) continue;
        const asset = release.assets?.find((item) => item.name === "release-lock.json" && item.url.startsWith(`${API}/releases/assets/`) && /^\d+$/.test(item.url.slice(`${API}/releases/assets/`.length)));
        if (!asset) continue;
        const lock = verifiedLock(await githubJson(asset.url, token, "application/octet-stream"));
        if (!lock || lock.tag !== release.tag_name || lock.commit === installed.gitSha ||
            canonical([...lock.schema_migrations].sort()) !== canonical([...installed.schemaMigrations].sort())) continue;
        const comparison = await githubJson(`${API}/compare/${installed.gitSha}...${lock.commit}`, token) as { status?: string };
        if (comparison.status !== "ahead") continue;
        const changes = release.body?.match(/(?:^|\n)## Изменения\s*\n([^#]{1,500})/i)?.[1].trim();
        if (!changes) continue;
        const run = await githubJson(`${API}/actions/runs/${lock.ci.run_id}`, token) as { conclusion?: string; head_sha?: string; event?: string; path?: string; run_attempt?: number };
        if (run.conclusion !== "success" || run.head_sha !== lock.commit || run.event !== "workflow_dispatch" ||
            run.path !== ".github/workflows/release.yml" || run.run_attempt !== Number(lock.ci.attempt)) continue;
        const tagRef = await githubJson(`${API}/git/ref/tags/${lock.tag}`, token) as { object?: { sha?: string; type?: string } };
        if (tagRef.object?.type !== "tag" || tagRef.object.sha !== lock.tag_object) continue;
        const tag = await githubJson(`${API}/git/tags/${lock.tag_object}`, token) as { object?: { sha?: string; type?: string } };
        if (tag.object?.type !== "commit" || tag.object.sha !== lock.commit) continue;
        const user = this.config.get<string>("UPDATE_GITHUB_USER") || "";
        if (!(await registryDigest(lock, "backend", token, user)) || !(await registryDigest(lock, "frontend", token, user))) continue;
        return { ...base, status: "available", available: {
          version: lock.tag, gitSha: lock.commit,
          backendDigest: lock.images.backend.digest, frontendDigest: lock.images.frontend.digest,
          compatibility: "exact-migrations", changes,
        } };
      }
      return { ...base, available: null, status: "current" };
    } catch {
      return { ...base, available: null, status: "check_unavailable" };
    }
  }
}
