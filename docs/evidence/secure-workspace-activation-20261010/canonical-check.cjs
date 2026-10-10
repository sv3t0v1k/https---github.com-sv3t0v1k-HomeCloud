// Read-only canonical snapshot. Do not print credentials or original database values.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {Client} = require('pg');
const {StorageMountRegistry, legacyBinding, LEGACY_STORAGE_ID} = require('/app/dist/storage/storage-mount-registry');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const registry = new StorageMountRegistry([legacyBinding('/storage', true)]);
  let diagnostic;
  try {
    diagnostic = registry.inspect(LEGACY_STORAGE_ID); // No write probe.
    assert.equal(diagnostic.state, 'online');
    assert.equal(diagnostic.capabilities.secureOpen, false);
  } finally { registry.close(); }
  const client = new Client({connectionString: process.env.DATABASE_URL});
  const tables = {};
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of ['upload_workspaces','users','files','folders','share_links','upload_sessions','upload_chunks','storage_locations','refresh_tokens','download_capabilities','migrations']) {
      const rows = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.value);
      tables[table] = {count: rows.length, digest: hash(JSON.stringify(rows))};
    }
    const bindings = (await client.query(`SELECT count(*)::int AS sessions, count(*) FILTER (WHERE "workspaceId"='87798389-88af-4ea5-a3e7-8e69a3c7bb01')::int AS bound FROM public.upload_sessions`)).rows[0];
    tables.bindings = bindings;
    const scratchSchemas = (await client.query(`SELECT count(*)::int AS count FROM information_schema.schemata WHERE schema_name ~ '^(workspace|uploads_bigint|files_b2|placement|sharing_test|locked_until|security|download|uploads_rate)_[0-9a-f]{32}$'`)).rows[0];
    await client.query('COMMIT');
    tables.temporarySchemaCount = scratchSchemas.count;
  } finally { await client.end(); }
  const files = [], directories = [];
  function walk(directory) {
    directories.push(path.relative('/storage', directory));
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory,name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Unexpected storage symlink');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({path:path.relative('/storage',file),dev:stat.dev,ino:stat.ino,size:stat.size,mode:stat.mode,uid:stat.uid,gid:stat.gid,mtimeMs:stat.mtimeMs,sha256:hash(fs.readFileSync(file))});
      else throw new Error('Unexpected storage object');
    }
  }
  walk('/storage');
  const workspace = fs.lstatSync('/storage/.tmp');
  const ingress = fs.lstatSync('/storage/.tmp/multipart-ingress');
  assert.equal(workspace.dev, ingress.dev);
  const healthResponse = await fetch('http://127.0.0.1:3000/api/v1/health/live');
  assert.equal(healthResponse.status, 200);
  console.log(JSON.stringify({tables,files,directories,runtime:{node:process.version,platform:process.platform,uid:process.getuid(),euid:process.geteuid(),diagnostic,workspaceDevice:workspace.dev,workspaceInode:workspace.ino,ingressDevice:ingress.dev,sameFilesystem:true,healthHttp:healthResponse.status,smokeScope:'read-only identity/health/snapshot; no rollout or new activation'}}));
})().catch(error => { console.error('Canonical read-only check failed: ' + error.message); process.exit(1); });
