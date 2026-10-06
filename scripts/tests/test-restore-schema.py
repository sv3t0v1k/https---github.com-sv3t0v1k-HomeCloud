#!/usr/bin/env python3
"""Run the real restore schema gate without stopping services or writing data."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
CORE = {'users', 'files', 'folders', 'share_links', 'upload_sessions', 'refresh_tokens', 'migrations'}

class RestoreSchema(unittest.TestCase):
    def gate(self, tables, count=None, query_fail=False, views=()):
        source = (ROOT / 'scripts/restore.sh').read_text()
        start = source.index('TABLE_COUNT=$(docker compose exec')
        end = source.index('# Verify key columns', start)
        block = source[start:end]
        env = dict(os.environ, TEST_TABLES=' '.join(tables),
                   TEST_COUNT=str(len(tables) if count is None else count),
                   TEST_QUERY_FAIL='1' if query_fail else '0', TEST_VIEWS=' '.join(views))
        script = '''set -euo pipefail
DB_USER=fixture
DB_NAME=fixture
EXPECTED_TABLE_NAMES="users files folders share_links upload_sessions refresh_tokens migrations"
log() { printf '%s\\n' "$*"; }
err() { printf '%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
docker() {
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
    "compose up -d") printf 'RECOVERY_START\\n' ;;
    *) printf 'UNEXPECTED_DOCKER_CALL\\n' >&2; return 99 ;;
  esac
}
'''
        return subprocess.run(['bash','-c',script + block],env=env,text=True,capture_output=True)

    def test_known_schema_generations(self):
        for extra in [set(), {'upload_chunks'}, {'upload_chunks', 'download_capabilities'}]:
            with self.subTest(extra=extra):
                result = self.gate(CORE | extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('All expected tables present: OK', result.stdout)
                self.assertNotIn('RECOVERY_START', result.stdout)

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
