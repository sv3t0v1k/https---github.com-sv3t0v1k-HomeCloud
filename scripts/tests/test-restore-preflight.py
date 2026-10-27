#!/usr/bin/env python3
"""Exercise real restore preflight/failure cleanup with fake Docker only.

Every invocation is a shell function: this suite cannot connect to a daemon.
SQL semantics are tested separately against an explicitly owned disposable DB.
"""
import gzip
import io
import tarfile
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CORE = 'users files folders share_links upload_sessions refresh_tokens migrations'
CURRENT = CORE + ' upload_chunks download_capabilities storage_locations upload_workspaces ssd_finalization_operations ssd_finalization_chunks public_share_operations archive_download_capabilities'
MIGRATIONS = []
for path in sorted((ROOT / 'backend/src/migrations').glob('*.ts')):
    timestamp = path.name.split('-', 1)[0]
    match = re.search(r'export class\s+([A-Za-z0-9]+)', path.read_text())
    if not match or not match.group(1).endswith(timestamp):
        raise AssertionError('Unexpected migration source: ' + path.name)
    MIGRATIONS.append(timestamp + ':' + match.group(1))
if len(MIGRATIONS) != 30:
    raise AssertionError('Expected 30 source migrations')

class RestorePreflight(unittest.TestCase):
    def run_fixture(self, tables=CURRENT, replay_fail=False, pending_fail=False,
                    destructive=False, final_rc=0, ownership_fail=False,
                    migration_fail=False, columns_fail=False, backend_volumes=False):
        source = (ROOT / 'scripts/restore.sh').read_text()
        start = source.index('# The dump is SQL, not a list of table names.')
        end = source.index('# Security: scan a storage', start)
        block = source[start:end]
        with tempfile.TemporaryDirectory(prefix='d1-restore-') as tmp:
            directory = Path(tmp)
            dump = directory / 'fixture.sql.gz'
            with gzip.open(dump, 'wt') as writer:
                writer.write('CREATE TABLE public.fixture (id integer);\n')
            archive = directory / 'fixture.tar.gz'
            with tarfile.open(archive, 'w:gz') as writer:
                entry = tarfile.TarInfo('user/file')
                entry.size = 4
                writer.addfile(entry, io.BytesIO(b'data'))
            env = dict(os.environ, TEST_ARCHIVE=str(archive), TEST_TMP=tmp, TEST_DUMP=str(dump),
                       TEST_SCRIPT_DIR=str(ROOT / 'scripts'), TEST_TABLES=tables,
                       TEST_MIGRATIONS='\n'.join(MIGRATIONS), TEST_CURRENT=CURRENT,
                       TEST_REPLAY_FAIL=str(int(replay_fail)), TEST_PENDING_FAIL=str(int(pending_fail)),
                       TEST_OWNERSHIP_FAIL=str(int(ownership_fail)), TEST_MIGRATION_FAIL=str(int(migration_fail)),
                       TEST_COLUMNS_FAIL=str(int(columns_fail)), TEST_BACKEND_VOLUMES=str(int(backend_volumes)))
            shim = r'''set -euo pipefail
log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
random_hex() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
DB_USER=fixture
DB_NAME=fixture
CORE_TABLE_NAMES="users files folders share_links upload_sessions refresh_tokens migrations"
PG_DUMP_FILE="$TEST_DUMP"
SCRIPT_DIR="$TEST_SCRIPT_DIR"
BACKEND_IMAGE=fixture-backend
STORAGE_PATH=/storage
STORAGE_ARCHIVE="$TEST_ARCHIVE"
MOCK_MIGRATED=0
docker() {
  printf '%s\n' "$*" >> "$TEST_TMP/docker.log"
  case "$*" in
    "compose config --format json") printf '{"services":{"db":{"image":"fixture-postgres"}}}\n' ;;
    "image inspect -f {{.Id}} fixture-postgres") printf 'sha256:fixtureimage\n' ;;
    "image inspect -f {{json .Config.Volumes}} sha256:fixtureimage") printf '{"/var/lib/postgresql/data":{}}\n' ;;
    "image inspect -f {{.Id}} fixture-backend") printf 'sha256:backendimage\n' ;;
    "image inspect -f {{json .Config.Volumes}} sha256:backendimage")
      if [ "$TEST_BACKEND_VOLUMES" = 1 ]; then printf '{"/storage":{}}\n'; else printf 'null\n'; fi ;;
    run*) cat > "$TEST_TMP/archive-metadata"; [ "$TEST_MIGRATION_FAIL" = 0 ] || return 9
      touch "$TEST_TMP/migrated" ;;
    create*) ;;
    start*) ;;
    "inspect -f"*) [ "$TEST_OWNERSHIP_FAIL" = 0 ] && printf '%s\n' "$VALIDATION_TOKEN" || printf 'foreign-token\n' ;;
    "rm -fv homecloud-restore-validation-"*) ;;
    "exec "*" pg_isready "*) ;;
    "exec -i "*|"compose exec -T db psql "*)
      case "$*" in
        *"SELECT count(*) FROM information_schema.tables"*) if [ -f "$TEST_TMP/migrated" ]; then set -- $TEST_CURRENT; else set -- $TEST_TABLES; fi; printf '%s\n' "$#" ;;
        *"SELECT 1 FROM information_schema.tables"*)
          local available="$TEST_TABLES"
          if [ -f "$TEST_TMP/migrated" ]; then available="$TEST_CURRENT"; fi
          for table in $available; do
            if [[ "$*" == *"table_name='$table'"* ]]; then printf '1\n'; return; fi
          done ;;
        *"SELECT timestamp::text"*) printf '%s\n' "$TEST_MIGRATIONS" ;;
        *"WHERE false"*) [ "$TEST_COLUMNS_FAIL" = 0 ] || return 10 ;;
        *"SELECT count(*) FROM public.migrations"*) printf '1\n' ;;
        *"SELECT string_agg"*) printf 'id,storagePath\n' ;;
        *"SELECT count(*) FROM users"*) printf '0\n' ;;
        *) local sql; sql=$(cat)
           if [[ "$sql" == *'DO $recovery_pending$'* ]]; then
             [ "$TEST_PENDING_FAIL" = 0 ] || return 7
           else [ "$TEST_REPLAY_FAIL" = 0 ] || return 8; fi ;;
      esac ;;
    "compose stop backend frontend") ;;
    *) printf 'Unexpected Docker fixture call: %s\n' "$*" >&2; return 99 ;;
  esac
}
'''
            action = '\nvalidate_dump_in_isolated_database\n'
            if destructive:
                action = f'\nRESTORE_DESTRUCTIVE=1\nexit {final_rc}\n'
            result = subprocess.run(['bash', '-c', shim + block + action], env=env,
                                    text=True, capture_output=True)
            calls = (directory / 'docker.log').read_text().splitlines() if (directory / 'docker.log').exists() else []
            return result, calls

    def assert_no_production_changes(self, calls):
        self.assertFalse(any(call.startswith('compose stop') or call.startswith('compose up')
                             or call.startswith('compose exec') for call in calls), calls)

    def test_current_schema_preflight_is_isolated_and_owned_cleanup(self):
        result, calls = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in calls if call.startswith('create '))
        for flag in ['--network none', '--read-only', '--tmpfs /var/lib/postgresql/data:',
                     '--pids-limit 128', '--memory 512m', '--cpus 1', '--security-opt no-new-privileges']:
            self.assertIn(flag, create)
        self.assertNotIn(' -v ', create)
        self.assertNotIn(' --mount ', create)
        self.assertNotIn(' -p ', create)
        self.assertTrue(any(call.startswith('rm -fv homecloud-restore-validation-') for call in calls))
        self.assert_no_production_changes(calls)

    def test_migration_replay_is_isolated_and_pinned(self):
        result, calls = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        migration = next((call for call in calls if call.startswith('run ')), '')
        self.assertTrue(migration, 'migration replay is missing')
        for flag in ['--network container:homecloud-restore-validation-', '--pull=never',
                     '--read-only', '--memory 512m', '--pids-limit 128',
                     '--tmpfs /storage:', '--tmpfs /tmp:', 'sha256:backendimage']:
            self.assertIn(flag, migration)
        self.assertIn('migration:run', '\n'.join(calls))
        self.assertNotIn(' -v ', migration)
        self.assertNotIn(' --volumes-from ', migration)
        self.assert_no_production_changes(calls)

    def test_migration_error_blocks_before_production(self):
        result, calls = self.run_fixture(migration_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('migration', result.stderr.lower())
        self.assert_no_production_changes(calls)

    def test_current_missing_required_columns_blocks_before_production(self):
        result, calls = self.run_fixture(columns_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('column', result.stderr.lower())
        self.assert_no_production_changes(calls)

    def test_backend_volume_declaration_blocks_helper_creation(self):
        result, calls = self.run_fixture(backend_volumes=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith('run ') for call in calls))
        self.assert_no_production_changes(calls)

    def test_historical_schema_preflight(self):
        result, calls = self.run_fixture(tables=CORE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_production_changes(calls)

    def test_sql_error_blocks_before_production(self):
        result, calls = self.run_fixture(replay_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('dump rejected', result.stderr)
        self.assert_no_production_changes(calls)

    def test_unknown_schema_blocks_before_production(self):
        result, calls = self.run_fixture(tables=CURRENT + ' unexpected')
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_production_changes(calls)

    def test_pending_ssd_blocks_before_production(self):
        result, calls = self.run_fixture(pending_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unsupported pending SSD', result.stderr)
        self.assert_no_production_changes(calls)

    def test_cleanup_refuses_foreign_container(self):
        result, calls = self.run_fixture(ownership_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith('rm ') for call in calls))
        self.assert_no_production_changes(calls)

    def test_destructive_failures_fence_writers_and_preserve_status(self):
        for code in [1, 7, 130, 143]:
            with self.subTest(code=code):
                result, calls = self.run_fixture(destructive=True, final_rc=code)
                self.assertEqual(result.returncode, code)
                self.assertEqual(calls, ['compose stop backend frontend'])
                self.assertIn('writers remain fenced', result.stderr)

    def test_owned_migration_writer_cleanup_and_foreign_refusal(self):
        source=(ROOT/'scripts/restore.sh').read_text()
        start=source.index('remove_restore_migration_container() {')
        end=source.index('remove_validation_container() {',start)
        block=source[start:end]
        for actual_token in ('own-token','foreign-token'):
            shim='''set -euo pipefail
RESTORE_TOKEN=own-token
RESTORE_MIGRATION_CONTAINER=own-migration
err() { :; }
docker() {
  case "$1" in
    inspect) printf '%s\n' "$TEST_TOKEN" ;;
    rm) printf 'REMOVED_OWN_MIGRATION\n' >&2 ;;
    *) return 99 ;;
  esac
}
'''
            result=subprocess.run(['bash','-c',shim+block+'\nremove_restore_migration_container\n'],env=dict(os.environ,TEST_TOKEN=actual_token),capture_output=True,text=True)
            self.assertEqual(result.returncode,0 if actual_token=='own-token' else 1)
            self.assertEqual('REMOVED_OWN_MIGRATION' in result.stderr,actual_token=='own-token')

    def test_success_cleanup_does_not_stop_services(self):
        result, calls = self.run_fixture(destructive=True, final_rc=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])

if __name__ == '__main__':
    unittest.main()
