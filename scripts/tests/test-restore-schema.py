#!/usr/bin/env python3
"""Run the real restore schema gate without stopping services or writing data."""
import os
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

class RestoreSchema(unittest.TestCase):
    def gate(self, tables, count=None, query_fail=False, views=()):
        source = (ROOT / 'scripts/restore.sh').read_text()
        if BASELINE:
            start = source.index('TABLE_COUNT=$(docker compose exec')
            end = source.index('# --- Storage restore', start)
            block = source[start:end]
        else:
            start = source.index('validate_restored_database() {')
            end = source.index('remove_validation_container() {', start)
            block = source[start:end] + '\nvalidate_restored_database\n' 
        env = dict(os.environ, TEST_TABLES=' '.join(tables),
                   TEST_COUNT=str(len(tables) if count is None else count),
                   TEST_QUERY_FAIL='1' if query_fail else '0', TEST_VIEWS=' '.join(views), TEST_SCRIPT_DIR=str(ROOT / 'scripts'))
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
  if [ "$#" = 0 ]; then cat >/dev/null; return 0; fi
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
