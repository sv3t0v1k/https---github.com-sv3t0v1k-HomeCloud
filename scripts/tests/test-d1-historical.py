#!/usr/bin/env python3
"""Opt-in historical D1 round trips in the runtime harness's owned fixtures.

Only explicit hc-d1-runtime images and random labeled disposable resources are
used. Importing this file or requesting --help never calls Docker. The owner
must execute the requested verification; this file is not an automatic test.
"""
import argparse
import gzip
import importlib.util
import json
from pathlib import Path
import sys

RUNTIME_PATH = Path(__file__).with_name('test-d1-runtime.py')
SPEC = importlib.util.spec_from_file_location('homecloud_d1_runtime', RUNTIME_PATH)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

GENERATIONS = (
    (7, 1746825120000),
    (8, 1746825130000),
    (9, 1746825140000),
    (10, 1746825150000),
    (11, 1746825170000),
    (13, 1746825180000),
    (13, 1746825190000),
)
TABLE_COUNT_SQL = "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"


def build_historical_schema(fixture, count, cutoff):
    # setup() first establishes an actual current schema and verifies every
    # resource's ownership. Rebuild only that own DB; storage remains its fixture.
    fixture.sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    program = r'''(async()=>{
const ds=require("./dist/data-source").default;
await ds.initialize();
try {
  ds.migrations=ds.migrations.filter(m=>{
    const match=String(m.name || m.constructor.name).match(/(\d{13})$/);
    if(!match) throw Error("Unrecognized migration identity");
    return Number(match[1])<=Number(process.argv[1]);
  });
  await ds.runMigrations();
} finally { await ds.destroy(); }
})().catch(error=>{console.error(error);process.exitCode=1});'''
    fixture.compose(['run', '--rm', '--no-deps', '-T', '--pull', 'never',
                     'backend', 'node', '-e', program, str(cutoff)])
    runtime.require(fixture.sql(TABLE_COUNT_SQL) == str(count),
                    'historical migrations did not produce expected table count')
    fixture.sql("INSERT INTO users (email,password,name,\"storageUsed\") VALUES ('d1-fixture@example.invalid','nonlogin-fixture','backup original',%d)" % len(runtime.PAYLOAD))
    if count < 10:
        fixture.sql("INSERT INTO files (name,\"storagePath\",size,\"userId\") VALUES ('object','/storage/fixture/object',%d,1)" % len(runtime.PAYLOAD))
    else:
        fixture.sql("INSERT INTO files (name,\"storagePath\",size,\"userId\",\"storageLocationId\",\"relativeObjectKey\") SELECT 'object','/storage/fixture/object',%d,1,id,'fixture/object' FROM storage_locations WHERE \"machineKey\"='legacy-storage'" % len(runtime.PAYLOAD))
    fixture.record['historical_source_table_count'] = count
    fixture.record['historical_migration_cutoff'] = cutoff
    fixture.h.save()


def historical_round_trip(harness, fixture, count, cutoff):
    build_historical_schema(fixture, count, cutoff)
    result, backup_log = harness.script(fixture, 'backup.sh')
    runtime.require(result.returncode == 0, 'historical backup failed: ' + backup_log)
    runtime.require(len(list(fixture.backups.glob('*.meta'))) == 1,
                    'historical fixture backup metadata count mismatch')
    fixture.mutate()
    before = fixture.state()
    runtime.require(before['bytes_sha256'] != runtime.sha(runtime.PAYLOAD),
                    'target byte mutation was not reproduced')
    result, restore_log = harness.script(fixture, 'restore.sh')
    runtime.require(result.returncode == 0, 'historical restore failed: ' + restore_log)
    after = fixture.state()
    runtime.require(fixture.sql(TABLE_COUNT_SQL) == '13', 'restored schema is not current13')
    migration = fixture.sql("SELECT count(*) FROM migrations WHERE timestamp=1746825200000 AND name='DurableUploadWholeSha2561746825200000'")
    runtime.require(migration == '1', 'restored migration520 metadata is absent or ambiguous')
    runtime.require(after['bytes_sha256'] == runtime.sha(runtime.PAYLOAD)
                    and 'backup original' in after['users'] and after['backend_running'],
                    'historical restored DB/storage/readiness mismatch')
    harness.case('historical%d cutoff%d round-trip' % (count, cutoff), {
        'source_table_count': count, 'source_migration_cutoff': cutoff,
        'restored_table_count': 13, 'migration520_present': True,
        'backup_log': backup_log, 'restore_log': restore_log,
        'before': before, 'after': after,
    })


def missing_current_column(harness, fixture):
    result, backup_log = harness.script(fixture, 'backup.sh')
    runtime.require(result.returncode == 0, 'current-column fixture backup failed: ' + backup_log)
    destination = runtime.clone_backup(fixture, 'missing-size-column')
    meta = json.loads(next(destination.glob('homecloud_*.meta')).read_text())
    raw = gzip.decompress((destination / meta['db_dump']).read_bytes())
    # Preserve current migration metadata while removing a field consumed by
    # reconciliation. Recompute all artifact checksums, so this reaches SQL and
    # compatibility replay rather than being rejected as corrupt transport.
    runtime.replace_dump(destination, raw + b'\nALTER TABLE public.files DROP COLUMN size CASCADE;\n')
    fixture.mutate()
    before = fixture.state()
    result, restore_log = harness.script(fixture, 'restore.sh', backup=destination)
    runtime.require(result.returncode != 0, 'missing current size column was accepted')
    runtime.require('required files columns' in (result.stdout + result.stderr).lower(),
                    'missing column did not reach current compatibility gate: ' + restore_log)
    runtime.require(fixture.state() == before, 'missing-column preflight changed target state')
    harness.case('current13 missing required column rejects before mutation', {
        'backup_log': backup_log, 'restore_log': restore_log,
        'target_unchanged': True, 'checksums_recomputed': True,
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--postgres-image', default='postgres:16-alpine')
    parser.add_argument('--baseline-root', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    runtime.require(Path(args.baseline_root).is_absolute(), 'baseline-root must be absolute')
    runtime.require(Path(args.evidence).is_absolute(), 'evidence path must be absolute')
    harness = runtime.Harness(args)
    before = harness.snapshot()
    harness.report['isolation']['before'] = before
    harness.report['limitations'].append('Historical preflight migration replay uses sparse path/size metadata; it does not establish per-file payload integrity or SSD recovery.')
    harness.save()
    error = None
    try:
        for count, cutoff in GENERATIONS:
            fixture = runtime.Fixture(harness, 'historical%d-%d' % (count, cutoff))
            try:
                fixture.setup()
                historical_round_trip(harness, fixture, count, cutoff)
            finally:
                fixture.cleanup()
        fixture = runtime.Fixture(harness, 'missing-current-column')
        try:
            fixture.setup()
            missing_current_column(harness, fixture)
        finally:
            fixture.cleanup()
        fixture = runtime.Fixture(harness, 'custom-root')
        try:
            fixture.setup()
            runtime.success(harness, fixture)
        finally:
            fixture.cleanup()
        harness.report['status'] = 'passed'
    except BaseException as exc:
        error = exc
        harness.report['status'] = 'failed'
        harness.report['error'] = str(exc)
    finally:
        after = harness.snapshot()
        harness.report['isolation']['after'] = after
        harness.report['isolation']['pre_existing_resources_identical'] = after == before
        if after != before:
            harness.report['status'] = 'failed'
            harness.report['isolation']['error'] = 'pre-existing snapshot changed or fixture residue exists'
            if error is None:
                error = runtime.FixtureError(harness.report['isolation']['error'])
        harness.save()
    print(json.dumps({'status': harness.report['status'],
                      'passed_cases': len(harness.report['cases']),
                      'evidence': str(harness.evidence)}, ensure_ascii=False))
    if error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
