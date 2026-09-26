import * as crypto from "crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не задана ${name}`);
  return value;
}
function dataOf<T>(body: unknown): T {
  return ((body as { data?: T })?.data ?? body) as T;
}
async function json(response: Response): Promise<unknown> {
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
    );
  return body;
}
export function deterministicChunk(size: number, index: number): Buffer {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw new Error("Некорректная граница deterministic chunk");
  const value = (index * 73 + 19) & 255;
  const chunk = Buffer.alloc(size, value);
  if (index === 0 && size >= 8)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(chunk);
  return chunk;
}

async function main() {
  const baseUrl = required("BENCH_BASE_URL");
  const email = required("BENCH_EMAIL");
  const password = required("BENCH_PASSWORD");
  const fileBytes = Number(required("BENCH_FILE_BYTES"));
  const chunkBytes = Number(required("BENCH_CHUNK_BYTES"));
  const totalChunks = Math.ceil(fileBytes / chunkBytes);
  const expected = crypto.createHash("sha256");
  const began = performance.now();
  const loginAt = performance.now();
  const auth = dataOf<{ accessToken: string }>(
    await json(
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    ),
  );
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const sessionAt = performance.now();
  const created = dataOf<{ uploadId: string }>(
    await json(
      await fetch(`${baseUrl}/api/v1/uploads/session`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          filename: `full-file-${fileBytes}.png`,
          totalSize: fileBytes,
          chunkSize: chunkBytes,
        }),
      }),
    ),
  );
  const sessionDone = performance.now();
  const chunks: Array<{
    index: number;
    status: number;
    bytes: number;
    latencyMs: number;
    cumulativeMs: number;
  }> = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const size = Math.min(chunkBytes, fileBytes - index * chunkBytes);
    const payload = deterministicChunk(size, index);
    expected.update(payload);
    const form = new FormData();
    form.append("chunkIndex", String(index));
    const bytes = new Uint8Array(payload.length);
    bytes.set(payload);
    form.append("chunk", new Blob([bytes]), `chunk-${index}.bin`);
    const at = performance.now();
    const response = await fetch(
      `${baseUrl}/api/v1/uploads/session/${created.uploadId}/chunk`,
      {
        method: "POST",
        headers: { ...headers, "x-benchmark-chunk-index": String(index) },
        body: form,
      },
    );
    await json(response);
    const done = performance.now();
    chunks.push({
      index,
      status: response.status,
      bytes: size,
      latencyMs: done - at,
      cumulativeMs: done - sessionDone,
    });
  }
  const completeAt = performance.now();
  const completed = await fetch(
    `${baseUrl}/api/v1/uploads/session/${created.uploadId}/complete`,
    { method: "POST", headers },
  );
  await json(completed);
  const completeDone = performance.now();
  process.stdout.write(
    JSON.stringify({
      uploadId: created.uploadId,
      expectedSha256: expected.digest("hex"),
      loginLatencyMs: sessionAt - loginAt,
      sessionLatencyMs: sessionDone - sessionAt,
      chunks,
      chunkPhaseMs: completeAt - sessionDone,
      completeLatencyMs: completeDone - completeAt,
      totalLatencyMs: completeDone - began,
      completeStatus: completed.status,
    }),
  );
}
if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
