import * as crypto from "crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не задана ${name}`);
  return value;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
async function hashResponse(
  response: Response,
): Promise<{ bytes: number; sha256: string }> {
  if (!response.ok || !response.body)
    throw new Error(`HTTP download ${response.status}`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}
function expectedRange(start: number, end: number, chunkBytes: number): Buffer {
  const result = Buffer.alloc(end - start + 1);
  let outputOffset = 0;
  let cursor = start;
  while (cursor <= end) {
    const chunkIndex = Math.floor(cursor / chunkBytes);
    const offsetInChunk = cursor % chunkBytes;
    const take = Math.min(end - cursor + 1, chunkBytes - offsetInChunk);
    result.fill(
      (chunkIndex * 73 + 19) & 255,
      outputOffset,
      outputOffset + take,
    );
    cursor += take;
    outputOffset += take;
  }
  return result;
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
  const minChunkIntervalMs = Number(
    process.env.BENCH_MIN_CHUNK_INTERVAL_MS ?? "0",
  );
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
    const remainingDelay = minChunkIntervalMs - (done - at);
    if (remainingDelay > 0) await sleep(remainingDelay);
  }
  const completeAt = performance.now();
  const completed = await fetch(
    `${baseUrl}/api/v1/uploads/session/${created.uploadId}/complete`,
    { method: "POST", headers },
  );
  const completedFile = dataOf<{ id: number }>(await json(completed));
  const completeDone = performance.now();
  const fullDownloadAt = performance.now();
  const fullDownloadResponse = await fetch(
    `${baseUrl}/api/v1/files/${completedFile.id}/download`,
    { headers },
  );
  const fullDownload = await hashResponse(fullDownloadResponse);
  const fullDownloadDone = performance.now();
  const rangeLength = 1024 * 1024;
  const rangeStart = Math.floor(fileBytes * 0.8);
  const rangeEnd = Math.min(fileBytes - 1, rangeStart + rangeLength - 1);
  const rangeAt = performance.now();
  const rangeResponse = await fetch(
    `${baseUrl}/api/v1/files/${completedFile.id}/download`,
    { headers: { ...headers, range: `bytes=${rangeStart}-${rangeEnd}` } },
  );
  const rangeBody = Buffer.from(await rangeResponse.arrayBuffer());
  const rangeDone = performance.now();
  const expectedRangeBody = expectedRange(rangeStart, rangeEnd, chunkBytes);
  if (
    rangeResponse.status !== 206 ||
    rangeResponse.headers.get("content-range") !==
      `bytes ${rangeStart}-${rangeEnd}/${fileBytes}` ||
    !rangeBody.equals(expectedRangeBody)
  )
    throw new Error("Некорректный late Range response");
  process.stdout.write(
    JSON.stringify({
      uploadId: created.uploadId,
      fileId: completedFile.id,
      expectedSha256: expected.digest("hex"),
      loginLatencyMs: sessionAt - loginAt,
      sessionLatencyMs: sessionDone - sessionAt,
      chunks,
      minChunkIntervalMs,
      chunkPhaseMs: completeAt - sessionDone,
      completeLatencyMs: completeDone - completeAt,
      fullDownload: {
        status: fullDownloadResponse.status,
        bytes: fullDownload.bytes,
        sha256: fullDownload.sha256,
        latencyMs: fullDownloadDone - fullDownloadAt,
      },
      lateRange: {
        status: rangeResponse.status,
        start: rangeStart,
        end: rangeEnd,
        bytes: rangeBody.length,
        contentRange: rangeResponse.headers.get("content-range"),
        latencyMs: rangeDone - rangeAt,
      },
      totalLatencyMs: rangeDone - began,
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
