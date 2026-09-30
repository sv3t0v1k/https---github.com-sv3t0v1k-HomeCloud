#!/usr/bin/env node
'use strict';
// Generates an external operator-owned env file; never prints secret values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = fs.realpathSync(path.resolve(__dirname, '..'));
try {
  if (process.argv.length !== 3) throw new Error('usage');
  const requested = path.resolve(process.argv[2]);
  const destination = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (destination === repo || destination.startsWith(repo + path.sep)) throw new Error('repository');
  const names = ['DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'METRICS_TOKEN', 'REDIS_PASSWORD'];
  const content = names.map(name => `${name}=${crypto.randomBytes(32).toString('hex')}`).join('\n') + '\n';
  const fd = fs.openSync(destination, 'wx', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  console.log('External secret file created with mode 0600. Add non-secret deployment settings before use.');
} catch {
  console.error('Secret generation failed: supply one new file path in an existing private directory outside the repository. Existing files are never overwritten.');
  process.exitCode = 1;
}
