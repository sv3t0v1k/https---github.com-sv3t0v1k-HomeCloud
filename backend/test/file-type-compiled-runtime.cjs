const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { deflateRawSync } = require("node:zlib");

// A parent deadline still works if a parser blocks the child event loop.
if (process.argv[2] !== "--parser-child") {
  const result = spawnSync(process.execPath, [__filename, "--parser-child"], {
    timeout: 10000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, "compiled file-type regression child must exit successfully");
  process.exit(0);
}

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

function zipContentTypes(xml) {
  const compressed = deflateRawSync(xml);
  const filename = Buffer.from("[Content_Types].xml");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(1, 22);
  header.writeUInt16LE(filename.length, 26);
  return Buffer.concat([header, filename, compressed]);
}

async function main() {
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  const detected = await fileTypeFromBuffer(pngHeader);

  assert.deepEqual(detected, { ext: "png", mime: "image/png" });

  // ASF header plus zero-size sub-header: GHSA-5v7r-6r5c-r473 is reachable
  // with only 55 bytes, well below both upload paths' 4100-byte header bound.
  const malformedAsf = Buffer.alloc(55);
  Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]).copy(malformedAsf);
  assert.equal(await fileTypeFromBuffer(malformedAsf), undefined);
  const asfHeader = malformedAsf.subarray(0, 30);
  assert.deepEqual(await fileTypeFromBuffer(asfHeader), {
    ext: "asf", mime: "application/vnd.ms-asf",
  });

  // An understated ZIP uncompressed size must not bypass the fixed inflate cap.
  // The fixture expands to 2 MiB but fits inside the actual upload header limit.
  const xml = Buffer.alloc(2 * 1024 * 1024, 0x20);
  Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">').copy(xml);
  const officeMarker = Buffer.from('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  officeMarker.copy(xml, xml.length - officeMarker.length);
  const smallOfficeZip = zipContentTypes(officeMarker);
  assert.deepEqual(await fileTypeFromBuffer(smallOfficeZip), {
    ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const malformedZip = zipContentTypes(xml);
  assert.ok(malformedZip.length < 4100);
  assert.deepEqual(await fileTypeFromBuffer(malformedZip), {
    ext: "zip", mime: "application/zip",
  });

  // Nest's independent validator entry point uses its own package resolution.
  const { FileTypeValidator } = require("@nestjs/common");
  for (const [buffer, mime] of [
    [pngHeader, "image/png"],
    [asfHeader, "application/vnd.ms-asf"],
    [malformedZip, "application/zip"],
  ]) {
    const validator = new FileTypeValidator({ fileType: mime });
    assert.equal(await validator.isValid({ buffer, mimetype: mime }), true);
    assert.equal(await new FileTypeValidator({ fileType: "image/jpeg" })
      .isValid({ buffer, mimetype: mime }), false);
  }
  assert.equal(await new FileTypeValidator({ fileType: "application/vnd.ms-asf" })
    .isValid({ buffer: malformedAsf, mimetype: "application/vnd.ms-asf" }), false);

  const { generateString } = require("@nestjs/typeorm/dist/common/typeorm.utils");
  const firstId = generateString();
  assert.match(firstId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(generateString(), firstId);
  process.stdout.write("compiled ESM loader: PNG/ASF/ZIP PASS; Nest validator acceptance/rejection PASS; TypeORM UUID generation PASS\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
