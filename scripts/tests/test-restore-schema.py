#!/usr/bin/env python3
"""Run the real restore schema gate without stopping services or writing data."""
import os
import re
import sys
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASELINE = '--baseline-root' in sys.argv
if BASELINE:
    marker = sys.argv.index('--baseline-root')
    ROOT = Path(sys.argv[marker + 1])
    del sys.argv[marker:marker + 2]
CORE = {'users', 'files', 'folders', 'share_links', 'upload_sessions', 'refresh_tokens', 'migrations'}
CURRENT_EXTRA = {'upload_chunks', 'download_capabilities', 'storage_locations', 'upload_workspaces',
                 'ssd_finalization_operations', 'ssd_finalization_chunks',
                 'public_share_operations', 'archive_download_capabilities'}

def source_migrations():
    rows = []
    for path in sorted((ROOT / 'backend/src/migrations').glob('*.ts')):
        timestamp = path.name.split('-', 1)[0]
        match = re.search(r'export class\s+([A-Za-z0-9]+)', path.read_text())
        if not match or not match.group(1).endswith(timestamp):
            raise AssertionError('Unexpected migration source: ' + path.name)
        rows.append(timestamp + ':' + match.group(1))
    if len(rows) != 30:
        raise AssertionError('Expected 30 source migrations')
    return rows

CURRENT_MIGRATIONS = [] if BASELINE else source_migrations()

class RestoreSchema(unittest.TestCase):
    def gate(self, tables, count=None, query_fail=False, views=(), current=False,
             migrations=None, missing_columns='', pending=False):
        source = (ROOT / 'scripts/restore.sh').read_text()
        if BASELINE:
            start = source.index('TABLE_COUNT=$(docker compose exec')
            end = source.index('# --- Storage restore', start)
            block = source[start:end]
        else:
            start = source.index('validate_restored_database() {')
            end = source.index('remove_validation_container() {', start)
            block = source[start:end] + ('\nvalidate_restored_database current\n' if current else '\nvalidate_restored_database\n')
        env = dict(os.environ, TEST_TABLES=' '.join(tables),
                   TEST_COUNT=str(len(tables) if count is None else count),
                   TEST_QUERY_FAIL='1' if query_fail else '0', TEST_VIEWS=' '.join(views),
                   TEST_SCRIPT_DIR=str(ROOT / 'scripts'),
                   TEST_MIGRATIONS='\n'.join(CURRENT_MIGRATIONS if migrations is None else migrations),
                   TEST_MISSING_COLUMNS=missing_columns, TEST_PENDING='1' if pending else '0')
        script = '''set -euo pipefail
DB_USER=fixture
DB_NAME=fixture
CORE_TABLE_NAMES="users files folders share_links upload_sessions refresh_tokens migrations"
EXPECTED_TABLE_NAMES="$CORE_TABLE_NAMES"
docker() { validation_psql "$@"; }
SCRIPT_DIR="$TEST_SCRIPT_DIR"
log() { printf '%s\\n' "$*"; }
err() { printf '%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
validation_psql() {
  if [ "$#" = 0 ]; then cat >/dev/null; [ "$TEST_PENDING" = 0 ]; return; fi
  case "$*" in
    *"SELECT count(*) FROM information_schema.tables"*)
      [ "$TEST_QUERY_FAIL" = 0 ] || return 1
      printf '%s\\n' "$TEST_COUNT" ;;
    *"SELECT 1 FROM information_schema.tables"*)
      local table
      for table in $TEST_TABLES; do
        if [[ "$*" == *"table_name='$table'"* ]]; then printf '1\\n'; return; fi
      done
      if [[ "$*" != *"table_type='BASE TABLE'"* ]]; then
        for table in $TEST_VIEWS; do
          if [[ "$*" == *"table_name='$table'"* ]]; then printf '1\\n'; return; fi
        done
      fi ;;
    *"SELECT string_agg(column_name"*) printf 'id,storagePath\\n' ;;
    *"SELECT count(*) FROM users"*) printf '0\\n' ;;
    *"SELECT timestamp::text"*) printf '%s\\n' "$TEST_MIGRATIONS" ;;
    *"FROM public."*"WHERE false"*)
      [[ "$*" != *"FROM public.$TEST_MISSING_COLUMNS WHERE false"* || -z "$TEST_MISSING_COLUMNS" ]] ;;
    "compose up -d") printf 'RECOVERY_START\\n' ;;
    *) printf 'UNEXPECTED_DOCKER_CALL\\n' >&2; return 99 ;;
  esac
}
'''
        return subprocess.run(['bash','-c',script + block],env=env,text=True,capture_output=True)

    def test_known_schema_generations(self):
        for extra in [set(), {'upload_chunks'}, {'upload_chunks', 'download_capabilities'}, {'upload_chunks', 'download_capabilities', 'storage_locations'}, {'upload_chunks', 'download_capabilities', 'storage_locations', 'upload_workspaces'}]:
            with self.subTest(extra=extra):
                result = self.gate(CORE | extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('All expected tables present: OK', result.stdout)
                self.assertNotIn('RECOVERY_START', result.stdout)

    def test_current_journal_schema_is_accepted(self):
        result = self.gate(CORE | {'upload_chunks', 'download_capabilities', 'storage_locations', 'upload_workspaces', 'ssd_finalization_operations', 'ssd_finalization_chunks'})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_confirmed_fifteen_table_backup_and_current_schema(self):
        for current in (False, True):
            with self.subTest(current=current):
                result = self.gate(CORE | CURRENT_EXTRA, current=current)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('All expected tables present: OK (15 tables)', result.stdout)

    def test_fifteen_table_replacements_are_rejected(self):
        for missing in ('public_share_operations', 'archive_download_capabilities', 'users'):
            with self.subTest(missing=missing):
                self.assertNotEqual(self.gate((CORE | CURRENT_EXTRA) - {missing} | {'unexpected'}).returncode, 0)

    def test_current_schema_requires_both_new_table_columns(self):
        for table in ('public_share_operations', 'archive_download_capabilities'):
            with self.subTest(table=table):
                self.assertNotEqual(self.gate(CORE | CURRENT_EXTRA, missing_columns=table).returncode, 0)

    def test_fifteen_table_schema_requires_exact_migrations(self):
        variants = [CURRENT_MIGRATIONS[:-1],
                    CURRENT_MIGRATIONS[:-1] + ['1792831200000:Unexpected1792831200000'],
                    CURRENT_MIGRATIONS[:-1] + [CURRENT_MIGRATIONS[-2]],
                    CURRENT_MIGRATIONS[:-1] + ['1792831200001:CreateArchiveDownloadCapabilities1792831200000']]
        for migrations in variants:
            with self.subTest(last=migrations[-1]):
                self.assertNotEqual(self.gate(CORE | CURRENT_EXTRA, migrations=migrations).returncode, 0)

    def test_pending_ssd_state_still_rejects_fifteen_tables(self):
        self.assertNotEqual(self.gate(CORE | CURRENT_EXTRA, pending=True).returncode, 0)

    def test_current_mode_rejects_old_thirteen_tables(self):
        self.assertNotEqual(self.gate(CORE | CURRENT_EXTRA - {'public_share_operations', 'archive_download_capabilities'}, current=True).returncode, 0)

    def test_destructive_restore_checks_final_schema_before_reconciliation(self):
        source = (ROOT / 'scripts/restore.sh').read_text()
        migration = source.index('log "  Migrations: OK"')
        current = source.index('validate_restored_database current', migration)
        reconciliation = source.index('RECONCILE_SCRIPT=', migration)
        self.assertLess(migration, current)
        self.assertLess(current, reconciliation)

    def test_unknown_schema_never_restarts_writers(self):
        result = self.gate(CORE | {'unexpected'}, count=12)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('RECOVERY_START', result.stdout)

    def test_workspace_cannot_replace_storage_location(self):
        self.assertNotEqual(self.gate(CORE | {'upload_chunks', 'download_capabilities', 'upload_workspaces'}).returncode, 0)

    def test_unknown_eleventh_table_is_rejected(self):
        self.assertNotEqual(self.gate(CORE | {'upload_chunks', 'download_capabilities', 'storage_locations', 'unexpected'}).returncode, 0)

    def test_unknown_extra_table_is_rejected(self):
        result = self.gate(CORE | {'upload_chunks','download_capabilities','unexpected'})
        self.assertNotEqual(result.returncode,0)

    def test_wrong_eighth_table_is_rejected(self):
        self.assertNotEqual(self.gate(CORE | {'download_capabilities'}).returncode,0)

    def test_missing_current_table_with_extra_is_rejected(self):
        result = self.gate(CORE | {'upload_chunks','unexpected'})
        self.assertNotEqual(result.returncode,0)

    def test_missing_core_table_even_with_same_count_is_rejected(self):
        result = self.gate((CORE - {'users'}) | {'unexpected'})
        self.assertNotEqual(result.returncode,0)

    def test_view_cannot_replace_expected_base_table(self):
        result = self.gate((CORE - {'users'}) | {'unexpected'}, views={'users'})
        self.assertNotEqual(result.returncode,0)

    def test_partial_schema_is_rejected(self):
        self.assertNotEqual(self.gate(CORE - {'files'}).returncode,0)

    def test_failed_count_query_is_rejected(self):
        self.assertNotEqual(self.gate(CORE, query_fail=True).returncode,0)

    def test_invalid_count_output_is_rejected(self):
        self.assertNotEqual(self.gate(CORE, count='invalid').returncode,0)

if __name__ == '__main__': unittest.main()
