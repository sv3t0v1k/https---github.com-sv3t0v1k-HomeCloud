const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname, '../generate-production-secrets.cjs');
test('external CSPRNG file is private, unique, never overwritten or printed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-secret-generation-'));
  try {
    const file = path.join(root, 'secrets.env');
    const run = () => spawnSync(process.execPath, [script, file], {encoding:'utf8'});
    const first = run(); assert.equal(first.status, 0);
    const content = fs.readFileSync(file, 'utf8');
    const values = content.trim().split('\n').map(line => line.split('=')[1]);
    assert.equal(values.length, 5); assert.equal(new Set(values).size, 5);
    for (const value of values) { assert.match(value, /^[a-f0-9]{64}$/); assert.ok(!first.stdout.includes(value)); }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(run().status, 1); assert.equal(fs.readFileSync(file,'utf8'),content);
    const repoFile = path.resolve(__dirname,'../must-not-create.env');
    assert.equal(spawnSync(process.execPath,[script,repoFile]).status,1); assert.ok(!fs.existsSync(repoFile));
    const link = path.join(root,'repo'); fs.symlinkSync(path.resolve(__dirname,'..'),link);
    assert.equal(spawnSync(process.execPath,[script,path.join(link,'must-not-create.env')]).status,1);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
