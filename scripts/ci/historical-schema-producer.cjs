/* Construct authentic migration-prefix fixtures in a separate disposable DB.
 * This is a fixture DataSource, never the application/target database.
 * Restoration subsequently uses the unchanged production datasource/fence.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PREFIXES = {
  7: [1746825120000, 18], 8: [1746825130000, 19],
  9: [1746825140000, 20], 10: [1746825150000, 21],
  11: [1746825170000, 23], 13: [1746825210000, 27],
  15: [1792831200000, 30],
};
const PAYLOAD = Buffer.from("HomeCloud backup restore proof\n");

function selectMigrations(count, filenames) {
  assert.ok(Object.hasOwn(PREFIXES, count), "Unsupported historical fixture schema");
  const [last, expected] = PREFIXES[count];
  const selected = filenames.filter(name => /^\d{13}-.+\.js$/.test(name))
    .filter(name => Number(name.slice(0, 13)) <= last).sort();
  assert.equal(selected.length, expected, "Historical migration prefix is incomplete");
  assert.equal(new Set(selected.map(name => name.slice(0, 13))).size, expected);
  assert.equal(Number(selected.at(-1).slice(0, 13)), last);
  return selected;
}

async function produce(count) {
  assert.ok(Object.hasOwn(PREFIXES, count), "Unsupported historical fixture schema");
  const url = new URL(process.env.HISTORY_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/fixture");
  assert.equal(url.username, "fixture");
  assert.equal(url.protocol, "postgres:");
  assert.equal(url.search + url.hash, "");
  assert.equal(process.env.STORAGE_PATH, "/storage");
  const { DataSource } = require("typeorm");
  const bcrypt = require("bcryptjs");
  const root = "/storage";
  fs.mkdirSync(root + "/.tmp", { mode: 0o700 });
  fs.mkdirSync(root + "/historical", { mode: 0o700 });
  fs.writeFileSync(root + "/historical/before-backup.txt", PAYLOAD, { mode: 0o600, flag: "wx" });
  const directory = "/app/dist/migrations";
  const migrations = selectMigrations(count, fs.readdirSync(directory));
  const connect = names => new DataSource({
    type: "postgres", url: url.toString(), synchronize: false, logging: false,
    entities: [], migrations: names.map(name => path.join(directory, name)),
  });
  // The first six migrations create the historical seven-table baseline.
  // Seed before placement migration so its real filesystem checks see bytes.
  const initial = connect(migrations.slice(0, 6));
  await initial.initialize();
  try {
    await initial.runMigrations({ transaction: "all" });
    await initial.query('INSERT INTO users (id,email,password,name,"storageQuota","storageUsed") VALUES (1,$1,$2,$3,$4,$5)',
      ["restore-fixture@example.invalid", await bcrypt.hash("E2eFixture!726184", 12), "Restore fixture", 104857600, PAYLOAD.length]);
    await initial.query('INSERT INTO files (id,name,"storagePath",size,"mimeType",checksum,"userId") VALUES (1,$1,$2,$3,$4,$5,1)',
      ["before-backup.txt", root + "/historical/before-backup.txt", PAYLOAD.length, "text/plain",
        crypto.createHash("sha256").update(PAYLOAD).digest("hex")]);
    for (const table of ["users", "files"])
      await initial.query("SELECT setval(pg_get_serial_sequence($1,'id')::regclass,1,true)", [table]);
  } finally { await initial.destroy(); }
  const historical = connect(migrations);
  await historical.initialize();
  try {
    await historical.runMigrations({ transaction: "all" });
    const tables = await historical.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    const applied = await historical.query("SELECT timestamp::text, name FROM migrations ORDER BY timestamp,name");
    assert.equal(tables.length, count);
    assert.equal(applied.length, migrations.length);
    assert.deepEqual(applied.map(row => Number(row.timestamp)), migrations.map(name => Number(name.slice(0, 13))));
    assert.equal((await historical.query('SELECT count(*)::integer AS count FROM files WHERE name=$1 AND size=$2',
      ["before-backup.txt", PAYLOAD.length]))[0].count, 1);
    console.log(JSON.stringify({ table_count: count, migration_count: applied.length,
      tables: tables.map(row => row.table_name), migrations: applied,
      payload_sha256: crypto.createHash("sha256").update(PAYLOAD).digest("hex") }));
  } finally { await historical.destroy(); }
}

if (require.main === module || !module.parent) produce(Number(process.argv[2])).catch(error => {
  console.error("Historical fixture generation failed: " + error.message);
  process.exitCode = 1;
});
module.exports = { PREFIXES, PAYLOAD, selectMigrations };
