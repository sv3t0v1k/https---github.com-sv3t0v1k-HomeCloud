import * as fs from "node:fs";
import { TextDecoder } from "node:util";
import { FinalizationOperation } from "./ssd-finalization-contract";
import { PostgresSsdFinalizationStore } from "./ssd-finalization-store";
import { fileTypeFromBuffer } from "./file-type.loader";

// Read the verified pinned inode. Positional reads never move the recovery cursor.
export async function checkpointSsdMime(
  store: PostgresSsdFinalizationStore,
  fd: number,
  operation: FinalizationOperation,
): Promise<void> {
  let mime = "application/octet-stream";
  try {
    const header = Buffer.alloc(Math.min(operation.totalSize, 4100));
    const count = fs.readSync(fd, header, 0, header.length, 0);
    const detected = await fileTypeFromBuffer(header.subarray(0, count));
    if (detected) mime = detected.mime;
    else if (await isText(fd, operation.totalSize)) mime = "text/plain";
  } catch {
    // Preview detection is metadata; valid bytes are always storable as binary.
  }
  await store.recordMimeType(operation.id, mime);
}

async function isText(fd: number, size: number): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const block = Buffer.alloc(64 * 1024);
  const allowed = (text: string) => ![...text].some(character => {
    const code = character.codePointAt(0)!;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
  });
  let offset = 0;
  try {
    while (offset < size) {
      const count = await new Promise<number>((resolve, reject) => fs.read(fd, block, 0,
        Math.min(block.length, size - offset), offset,
        (error, bytes) => error ? reject(error) : resolve(bytes)));
      if (!count) return false;
      if (!allowed(decoder.decode(block.subarray(0, count), { stream: true }))) return false;
      offset += count;
    }
    return allowed(decoder.decode());
  } catch { return false; }
}
