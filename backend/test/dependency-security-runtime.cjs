const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const request = require('supertest');
const nestRequire = createRequire(require.resolve('@nestjs/platform-express/package.json'));
const multer = nestRequire('multer');
const express = nestRequire('express');
const sharp = require('sharp');
const proxyaddr = nestRequire('proxy-addr');
const { getMulterFileSizeLimit } = require('../dist/uploads/chunk-ingress');

function uploadApp(options) {
  const app = express();
  app.post('/upload', multer(options).single('chunk'), (req, res) => {
    res.json({ size: req.file?.size, body: req.body });
  });
  app.use((error, _req, res, _next) => {
    res.status(400).json({ code: error.code || 'UPLOAD_ERROR' });
  });
  return app;
}

test('Nest and direct imports use the same patched Multer', () => {
  assert.equal(multer, require('multer'));
  assert.equal(nestRequire('multer/package.json').version, '2.5.0');
});

test('compiled production limit accepts N bytes and rejects N + 1', async () => {
  const app = uploadApp({ limits: {
    fileSize: getMulterFileSizeLimit('8'), fields: 1, files: 1, parts: 2,
    fieldSize: 32, fieldNameSize: 64,
  } });
  const accepted = await request(app).post('/upload').field('index', '0')
    .attach('chunk', Buffer.alloc(8), 'chunk.bin');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.size, 8);
  const rejected = await request(app).post('/upload').field('index', '0')
    .attach('chunk', Buffer.alloc(9), 'chunk.bin');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'LIMIT_FILE_SIZE');
});

test('inclusive parts limit rejects a third part', async () => {
  const app = uploadApp({ limits: { fileSize: 8, files: 1, parts: 2 } });
  const response = await request(app).post('/upload').field('index', '0')
    .field('extra', '1').attach('chunk', Buffer.alloc(1), 'chunk.bin');
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'LIMIT_PART_COUNT');
});

test('crafted multipart field names produce an error, then normal traffic succeeds', async () => {
  const app = uploadApp({ limits: { fieldNameSize: 64 } });
  const response = await request(app).post('/upload')
    .field('a[4294967294]', 'x').field('a[]', 'y');
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INVALID_FIELD_NAME');
  const healthy = await request(app).post('/upload').field('index', '0')
    .attach('chunk', Buffer.alloc(1), 'chunk.bin');
  assert.equal(healthy.status, 200);
});

test('aborted request cleans a custom storage write that completes after abort', async () => {
  let finishWrite;
  let removed = 0;
  let handled = 0;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const storage = {
    _handleFile(_req, file, callback) {
      handled++;
      file.path = 'test-owned-pending-write';
      file.stream.resume();
      finishWrite = () => callback(null, { path: file.path, size: 1 });
      readyResolve();
    },
    _removeFile(_req, _file, callback) { removed++; callback(null); },
  };
  const req = new PassThrough();
  const boundary = 'homecloud-security-test';
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' };
  let nextCalls = 0;
  const completed = new Promise((resolve) => {
    multer({ storage }).single('chunk')(req, {}, error => { nextCalls++; resolve(error); });
  });
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.bin"\r\nContent-Type: application/octet-stream\r\n\r\nx`);
  await ready;
  req.emit('aborted');
  finishWrite();
  req.destroy();
  const error = await completed;
  assert.equal(error.message, 'Request aborted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 1);
  assert.equal(removed, 1);
  assert.equal(nextCalls, 1);
});

test('Sharp native decoder preserves thumbnail behavior and rejects malformed bytes', async () => {
  assert.equal(sharp.versions.sharp, '0.35.5');
  assert.equal(sharp.versions.rsvg, '2.63.2');
  for (const format of ['jpeg', 'png']) {
    const input = await sharp({ create: {
      width: 400, height: 200, channels: 3, background: '#336699',
    } }).toFormat(format).toBuffer();
    const thumbnail = await sharp(input).resize(300, 300, {
      fit: 'inside', withoutEnlargement: true,
    }).png().toBuffer();
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.width, 300);
    assert.equal(metadata.height, 150);
    assert.equal(metadata.format, 'png');
  }
  await assert.rejects(sharp(Buffer.from('invalid image')).png().toBuffer());
});

test('proxy-addr rejects IPv4 spoofing through short mapped IPv6 CIDR', () => {
  const invalidMapped = proxyaddr.compile('::ffff:10.0.0.0/8');
  const validMapped = proxyaddr.compile('::ffff:10.0.0.0/104');
  assert.equal(invalidMapped('203.0.113.7'), false);
  assert.equal(validMapped('203.0.113.7'), false);
  assert.equal(validMapped('10.1.2.3'), true);
  const req = { socket: { remoteAddress: '203.0.113.7' }, headers: {
    'x-forwarded-for': '10.1.2.3',
  } };
  assert.equal(proxyaddr(req, invalidMapped), '203.0.113.7');
});
