import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { FileEntity } from "../src/entities/file.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { UserEntity } from "../src/entities/user.entity";

export type PreflightStage =
  | "AUTH"
  | "CREATE_SESSION"
  | "MULTIPART_CHUNK"
  | "COMPLETE"
  | "VERIFY"
  | "CLEANUP";

export interface StageEvidence {
  stage: PreflightStage;
  ok: boolean;
  status?: number;
  body?: unknown;
  errorType?: string;
}

export interface PreflightOptions {
  baseUrl: string;
  databaseUrl: string;
  storagePath: string;
  payload: Buffer;
  label: string;
  confirm: string;
  fetchImpl?: typeof fetch;
}

export interface PreflightResult {
  label: string;
  sha256: string;
  evidence: StageEvidence[];
}

export type Classification = "HEALTHY" | "RISK_CONFIRMED" | "INCONCLUSIVE";

export function classifyStage(
  result: PreflightResult | undefined,
  stage: PreflightStage,
  expectedFailureStatuses: number[] = [],
): Classification {
  if (!result) return "INCONCLUSIVE";
  const item = result.evidence.find((entry) => entry.stage === stage);
  if (!item) return "INCONCLUSIVE";
  if (item.ok) return "HEALTHY";
  return item.status !== undefined &&
    expectedFailureStatuses.includes(item.status)
    ? "RISK_CONFIRMED"
    : "INCONCLUSIVE";
}

const BODY_LIMIT = 2048;
export const STORAGE_MARKER = ".homecloud-http-preflight-owned";

export function assertSafeTargets(options: PreflightOptions): void {
  if (options.confirm !== "YES_ISOLATED_HTTP_PREFLIGHT") {
    throw new Error(
      "Требуется явное подтверждение изолированного HTTP preflight",
    );
  }
  const db = new URL(options.databaseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(db.hostname)) {
    throw new Error("База preflight должна находиться на loopback-интерфейсе");
  }
  if (
    db.port !== "55441" ||
    db.pathname !== "/homecloud_http_preflight" ||
    ["homecloud", "postgres"].includes(decodeURIComponent(db.username))
  ) {
    throw new Error(
      "Разрешена только выделенная БД homecloud_http_preflight на порту 55441",
    );
  }
  const resolvedStorage = path.resolve(options.storagePath);
  const tmpRoot = path.resolve(os.tmpdir());
  const privateTmpRoot = path.resolve("/private/tmp");
  if (
    ![tmpRoot, privateTmpRoot].some((root) =>
      resolvedStorage.startsWith(root + path.sep),
    ) ||
    !path.basename(resolvedStorage).startsWith("homecloud-http-preflight-")
  ) {
    throw new Error(
      "Хранилище preflight должно быть отдельным каталогом в tmp",
    );
  }
  const marker = path.join(resolvedStorage, STORAGE_MARKER);
  if (
    !fs.existsSync(marker) ||
    fs.readFileSync(marker, "utf8") !== options.confirm
  ) {
    throw new Error("Хранилище preflight не имеет ownership-marker");
  }
  const base = new URL(options.baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(base.hostname)) {
    throw new Error("HTTP preflight разрешён только через loopback-интерфейс");
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|password|authorization/i.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return value;
}

function bounded(value: unknown): unknown {
  const safeValue = redact(value);
  const text =
    typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue);
  if (!text) return value;
  return text.length <= BODY_LIMIT
    ? safeValue
    : `${text.slice(0, BODY_LIMIT)}…`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function dataOf<T>(body: unknown): T {
  const envelope = body as { data?: T };
  return (envelope?.data ?? body) as T;
}

async function request(
  evidence: StageEvidence[],
  stage: PreflightStage,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  try {
    const response = await fetchImpl(url, init);
    const body = await responseBody(response);
    evidence.push({
      stage,
      ok: response.ok,
      status: response.status,
      body: bounded(body),
    });
    return { response, body };
  } catch (error) {
    evidence.push({
      stage,
      ok: false,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

export function makeMultipart(payload: Buffer): FormData {
  const form = new FormData();
  // FormData stringifies this value. This intentionally reproduces browser
  // multipart semantics instead of smuggling a JSON number into the request.
  form.append("chunkIndex", "0");
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  form.append("chunk", new Blob([bytes]), "chunk.bin");
  return form;
}

export async function runHttpPreflight(
  options: PreflightOptions,
  dataSource: DataSource,
): Promise<PreflightResult> {
  assertSafeTargets(options);
  const evidence: StageEvidence[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const suffix = crypto.randomBytes(8).toString("hex");
  const email = `http-preflight-${suffix}@homecloud.local`;
  const password = `HttpPreflight-${suffix}-password`;
  const filename = `http-preflight-${suffix}.bin`;
  const sha256 = crypto
    .createHash("sha256")
    .update(options.payload)
    .digest("hex");
  let userId: number | undefined;
  let uploadId: string | undefined;

  try {
    const auth = await request(
      evidence,
      "AUTH",
      fetchImpl,
      `${options.baseUrl}/api/v1/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: "HTTP preflight" }),
      },
    );
    if (!auth.response.ok) return { label: options.label, sha256, evidence };
    const user = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ email });
    userId = user.id;
    const authData = dataOf<{ accessToken: string }>(auth.body);
    if (!authData.accessToken) throw new Error("AUTH не вернул accessToken");
    const initialStorageUsed = Number(user.storageUsed);
    const headers = { authorization: `Bearer ${authData.accessToken}` };

    const created = await request(
      evidence,
      "CREATE_SESSION",
      fetchImpl,
      `${options.baseUrl}/api/v1/uploads/session`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          filename,
          totalSize: options.payload.length,
          chunkSize: options.payload.length,
        }),
      },
    );
    if (!created.response.ok) return { label: options.label, sha256, evidence };
    uploadId = dataOf<{ uploadId: string }>(created.body).uploadId;
    if (!uploadId) throw new Error("CREATE_SESSION не вернул uploadId");

    const chunk = await request(
      evidence,
      "MULTIPART_CHUNK",
      fetchImpl,
      `${options.baseUrl}/api/v1/uploads/session/${uploadId}/chunk`,
      { method: "POST", headers, body: makeMultipart(options.payload) },
    );
    if (!chunk.response.ok) return { label: options.label, sha256, evidence };

    const completed = await request(
      evidence,
      "COMPLETE",
      fetchImpl,
      `${options.baseUrl}/api/v1/uploads/session/${uploadId}/complete`,
      { method: "POST", headers },
    );
    if (!completed.response.ok)
      return { label: options.label, sha256, evidence };

    const files = await dataSource.getRepository(FileEntity).findBy({ userId });
    const session = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneBy({ userId, uploadId });
    const refreshed = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: userId });
    const finalPath = files[0]?.storagePath;
    const exactBytes = finalPath ? fs.readFileSync(finalPath) : null;
    const verified =
      files.length === 1 &&
      Number(files[0].size) === options.payload.length &&
      session?.status === "completed" &&
      Number(refreshed.storageUsed) - initialStorageUsed ===
        options.payload.length &&
      exactBytes?.equals(options.payload) === true &&
      crypto.createHash("sha256").update(exactBytes).digest("hex") === sha256;
    evidence.push({ stage: "VERIFY", ok: verified });
    return { label: options.label, sha256, evidence };
  } finally {
    let cleanupOk = true;
    try {
      if (userId !== undefined) {
        const files = await dataSource
          .getRepository(FileEntity)
          .findBy({ userId });
        for (const file of files) {
          if (file.storagePath && fs.existsSync(file.storagePath))
            fs.unlinkSync(file.storagePath);
        }
        await dataSource.getRepository(UserEntity).delete(userId);
      }
      if (uploadId) {
        fs.rmSync(path.join(options.storagePath, ".tmp", uploadId), {
          recursive: true,
          force: true,
        });
      }
      if (userId !== undefined) {
        fs.rmSync(path.join(options.storagePath, String(userId)), {
          recursive: true,
          force: true,
        });
        const [usersLeft, filesLeft, sessionsLeft] = await Promise.all([
          dataSource.getRepository(UserEntity).countBy({ id: userId }),
          dataSource.getRepository(FileEntity).countBy({ userId }),
          dataSource.getRepository(UploadSessionEntity).countBy({ userId }),
        ]);
        cleanupOk =
          usersLeft === 0 &&
          filesLeft === 0 &&
          sessionsLeft === 0 &&
          !fs.existsSync(path.join(options.storagePath, String(userId))) &&
          (!uploadId ||
            !fs.existsSync(path.join(options.storagePath, ".tmp", uploadId)));
      }
    } catch {
      cleanupOk = false;
    }
    evidence.push({ stage: "CLEANUP", ok: cleanupOk });
  }
}
