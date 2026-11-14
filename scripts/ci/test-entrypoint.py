#!/usr/bin/env python3
"""Fenced supervisor dispatch and literal argv, without Docker or live DB."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[2] / 'backend/docker/entrypoint.sh'
MIGRATE = ['./node_modules/typeorm/cli.js', 'migration:run', '-d',
           'dist/data-source.js', '--transaction', 'all']


class EntrypointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / 'calls.jsonl'
        node = self.root / 'node'
        node.write_text(f'#!{sys.executable}\n'
                        'import json, os, sys\n'
                        'with open(os.environ["CALL_LOG"], "a") as log:\n'
                        '    log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                        'if sys.argv[1:2] == ["docker/copy-root-fence-supervisor.cjs"]:\n'
                        '    sys.exit(int(os.environ.get("SUPERVISOR_EXIT", "0")))\n')
        node.chmod(0o755)

    def run_entrypoint(self, args, supervisor_exit=0):
        result = subprocess.run(['sh', str(ENTRYPOINT), *args], capture_output=True,
                                text=True, env={**os.environ,
                                    'PATH': str(self.root) + ':' + os.environ['PATH'],
                                    'CALL_LOG': str(self.log),
                                    'SUPERVISOR_EXIT': str(supervisor_exit)})
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_normal_api_delegates_to_fenced_supervisor(self):
        result, calls = self.run_entrypoint(['node', 'dist/main.js'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [['docker/copy-root-fence-supervisor.cjs']])

    def test_failed_supervisor_stops_entrypoint(self):
        result, calls = self.run_entrypoint(['node', 'dist/main.js'], 42)
        self.assertEqual(result.returncode, 42)
        self.assertEqual(calls, [['docker/copy-root-fence-supervisor.cjs']])

    def test_operator_migration_routes_through_supervisor(self):
        result, calls = self.run_entrypoint(['node', *MIGRATE])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [[
            'docker/copy-root-fence-supervisor.cjs',
            '--operator-cli', 'node', *MIGRATE
        ]])

    def test_operator_supervisor_failure_propagates(self):
        result, calls = self.run_entrypoint(['node', *MIGRATE], 43)
        self.assertEqual(result.returncode, 43)
        self.assertEqual(calls, [[
            'docker/copy-root-fence-supervisor.cjs',
            '--operator-cli', 'node', *MIGRATE
        ]])

    def test_schema_drop_routes_to_supervisor_for_rejection(self):
        args = ['node', './node_modules/typeorm/cli.js',
                'schema:drop', '-d', 'dist/data-source.js']
        result, calls = self.run_entrypoint(args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [[
            'docker/copy-root-fence-supervisor.cjs',
            '--operator-cli', *args
        ]])

    def test_helper_has_literal_argv_and_no_migration(self):
        literal = '$(touch SHOULD_NOT_EXIST); spaces'
        result, calls = self.run_entrypoint(['node', '-e', literal])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [['-e', literal]])

    def test_api_with_extra_arguments_does_not_implicitly_migrate(self):
        result, calls = self.run_entrypoint(['node', 'dist/main.js', 'extra'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [['dist/main.js', 'extra']])


if __name__ == '__main__':
    unittest.main()
