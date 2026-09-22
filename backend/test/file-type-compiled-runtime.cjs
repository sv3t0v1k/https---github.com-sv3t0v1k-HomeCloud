const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const compiledLoaderPath = path.join(
  __dirname,
  "..",
  "dist",
  "uploads",
  "file-type.loader.js",
);
const compiledSource = fs.readFileSync(compiledLoaderPath, "utf8");

assert.doesNotMatch(
  compiledSource,
  /require\(["']file-type["']\)/,
  "CommonJS output must not load the ESM-only file-type package with require()",
);

const { fileTypeFromBuffer } = require(compiledLoaderPath);

async function main() {
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  const detected = await fileTypeFromBuffer(pngHeader);

  assert.deepEqual(detected, { ext: "png", mime: "image/png" });
  process.stdout.write("compiled CommonJS runtime loaded file-type via native ESM import\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
