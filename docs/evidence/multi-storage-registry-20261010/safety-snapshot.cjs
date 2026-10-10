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
    for (const table of ['users','files','folders','share_links','upload_sessions','upload_chunks','storage_locations','refresh_tokens','download_capabilities','migrations']) {
      const rows = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.value);
      tables[table] = {count: rows.length, digest: hash(JSON.stringify(rows))};
    }
  } finally { await client.end(); }
  const files = [], directories = [];
  function walk(directory) {
    directories.push(path.relative('/storage', directory));
    for (const name of fs.readdirSync(directory).sort()) {
      if (directory === '/storage' && name === '.homecloud-storage-identity') continue;
      const file = path.join(directory,name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Unexpected storage symlink');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({path:path.relative('/storage',file),dev:stat.dev,ino:stat.ino,size:stat.size,mode:stat.mode,uid:stat.uid,gid:stat.gid,mtimeMs:stat.mtimeMs,sha256:hash(fs.readFileSync(file))});
      else throw new Error('Unexpected storage object');
    }
  }
  walk('/storage');
  console.log(JSON.stringify({tables,files,directories}));
})().catch(() => { console.error('Snapshot failed'); process.exit(1); });
