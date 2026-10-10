// Run inside canonical backend: hashes only, never export original DB values.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {Client} = require('pg');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const client = new Client({connectionString: process.env.DATABASE_URL});
  const tables = {};
  await client.connect();
  try {
    for (const table of ['upload_workspaces','users','files','folders','share_links','upload_sessions','upload_chunks','storage_locations','refresh_tokens','download_capabilities','migrations']) {
      const rows = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.value);
      tables[table] = {count: rows.length, digest: hash(JSON.stringify(rows))};
    }
    const bindings=(await client.query(`SELECT count(*)::int AS sessions, count(*) FILTER (WHERE "workspaceId"='87798389-88af-4ea5-a3e7-8e69a3c7bb01')::int AS bound FROM upload_sessions`)).rows[0];
    tables.bindings=bindings;
    tables.bindingDigest=hash(JSON.stringify((await client.query('SELECT id, "workspaceId" FROM upload_sessions ORDER BY id')).rows));
    tables.disposableSchemas=(await client.query("SELECT count(*)::int AS count FROM information_schema.schemata WHERE schema_name LIKE 'hc_%'")).rows[0].count;
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
  const userFiles=files.filter(f=>f.path!=='.homecloud-storage-identity');
  console.log(JSON.stringify({tables,fileInventoryDigest:hash(JSON.stringify(files)),directoryInventoryDigest:hash(JSON.stringify(directories)),allFilesIncludingIdentityMarker:files.length,physicalUserFiles:userFiles.length,physicalUserBytes:userFiles.reduce((n,f)=>n+f.size,0)}));
})().catch(() => { console.error('Snapshot failed'); process.exit(1); });
