type FileTypeModule = typeof import("file-type");

// TypeScript rewrites import() to require() when emitting CommonJS. Constructing
// the import expression at runtime preserves Node's native ESM loader for the
// ESM-only file-type package without changing the backend module system.
const loadFileTypeModule = new Function(
  'return import("file-type")',
) as () => Promise<FileTypeModule>;

export async function fileTypeFromBuffer(
  buffer: Uint8Array | ArrayBuffer,
): ReturnType<FileTypeModule["fileTypeFromBuffer"]> {
  const fileType = await loadFileTypeModule();
  return fileType.fileTypeFromBuffer(buffer);
}
