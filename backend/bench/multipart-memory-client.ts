import * as crypto from "crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана ${name}`);
  return value;
}
function dataOf<T>(body: unknown): T {
  return ((body as { data?: T })?.data ?? body) as T;
}
async function json(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
    );
  return body;
}

async function main() {
  const baseUrl = required("BENCH_BASE_URL");
  const size = Number(required("BENCH_CHUNK_BYTES"));
  const concurrency = Number(required("BENCH_CONCURRENCY"));
  const runId = required("BENCH_RUN_ID");
  const sessions: Array<{
    token: string;
    uploadId: string;
    email: string;
    sha256: string;
  }> = [];
  for (let i = 0; i < concurrency; i += 1) {
    const email = `multipart-${runId}-${i}@homecloud.local`;
    const password = `Multipart-${runId}-${i}-password`;
    const auth = dataOf<{ accessToken: string }>(
      await json(
        await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      ),
    );
    const token = auth.accessToken;
    const created = dataOf<{ uploadId: string }>(
      await json(
        await fetch(`${baseUrl}/api/v1/uploads/session`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            filename: `multipart-${runId}-${i}.bin`,
            totalSize: size,
            chunkSize: size,
          }),
        }),
      ),
    );
    sessions.push({ token, uploadId: created.uploadId, email, sha256: "" });
  }
  const startAt = Date.now() + 750;
  const requests = sessions.map(async (session, index) => {
    const payload = Buffer.allocUnsafe(size);
    payload.fill((index * 37 + 11) & 255);
    session.sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    const form = new FormData();
    form.append("chunkIndex", "0");
    form.append("chunk", new Blob([payload]), `chunk-${index}.bin`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, startAt - Date.now())),
    );
    const began = performance.now();
    const response = await fetch(
      `${baseUrl}/api/v1/uploads/session/${session.uploadId}/chunk`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
        body: form,
      },
    );
    await json(response);
    const ended = performance.now();
    await json(
      await fetch(
        `${baseUrl}/api/v1/uploads/session/${session.uploadId}/complete`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}` },
        },
      ),
    );
    return {
      index,
      status: response.status,
      latencyMs: ended - began,
      beganMs: began,
      endedMs: ended,
    };
  });
  const results = await Promise.all(requests);
  process.stdout.write(JSON.stringify({ sessions, results }));
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
