import { createReadStream } from "fs";
import { TextDecoder } from "util";

/** Validate every byte, without trusting filenames or buffering the whole file. */
export async function isUtf8PlainText(filePath: string): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hasForbiddenControls = (text: string): boolean => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          (code >= 127 && code <= 159)) return true;
    }
    return false;
  };
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      let text: string;
      try { text = decoder.decode(chunk as Buffer, { stream: true }); }
      catch { return false; }
      if (hasForbiddenControls(text)) return false;
    }
    try { return !hasForbiddenControls(decoder.decode()); }
    catch { return false; }
  } finally { stream.destroy(); }
}
