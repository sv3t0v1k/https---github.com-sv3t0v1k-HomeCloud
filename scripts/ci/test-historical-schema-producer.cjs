"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { PREFIXES, selectMigrations } = require("./historical-schema-producer.cjs");
const files = fs.readdirSync(path.join(__dirname, "../../backend/src/migrations"))
  .map(name => name.replace(/\.ts$/, ".js")).sort();

test("every supported historical state uses an exact existing migration prefix", () => {
  assert.deepEqual(Object.keys(PREFIXES), ["7", "8", "9", "10", "11", "13", "15"]);
  for (const count of Object.keys(PREFIXES)) {
    const selected = selectMigrations(count, files);
    assert.equal(selected.length, PREFIXES[count][1]);
    assert.ok(!selected.some(name => name.includes("FileCopyAdmission")));
  }
});
test("missing migration cannot produce a false historical qualification", () => {
  assert.throws(() => selectMigrations(15, files.slice(1)), /incomplete/);
});
test("duplicate timestamps cannot impersonate an exact prefix", () => {
  const altered = [...files];
  altered[1] = altered[0].slice(0, 13) + "-Duplicate.js";
  assert.throws(() => selectMigrations(7, altered));
});
test("intermediate or current schemas are not mislabeled historical", () => {
  for (const count of [12, 14, 17, 0])
    assert.throws(() => selectMigrations(count, files), /Unsupported/);
});
test("stdin invocation really enters the producer and refuses invalid inputs before DB access", () => {
  const source = fs.readFileSync(path.join(__dirname, "historical-schema-producer.cjs"), "utf8");
  const result = spawnSync(process.execPath, ["-", "0"], {input:source,encoding:"utf8",timeout:5000});
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported historical fixture schema/);
});
