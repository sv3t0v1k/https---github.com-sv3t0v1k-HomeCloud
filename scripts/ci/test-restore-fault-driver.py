#!/usr/bin/env python3
"""Fault instrumentation/guard contracts; no daemon or real signal is used."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('fault_fixture', Path(__file__).with_name('test-restore-fault-e2e.py'))
fault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fault)

SOURCE = b'''
from types import SimpleNamespace
events=[]
class StorageError(Exception): pass
def write_receipt(state,receipt,first=False): events.append("durable:"+receipt["phase"])
def verify(*args,**kwargs): events.append("clear" if kwargs.get("clear") else "verify")
def stop(*args): events.append(list(args))
def writers(*args): raise StorageError("foreign fixture writer")
storage=SimpleNamespace(verify_backup_inhibitor=verify,release_compose=stop,StorageError=StorageError,verify_backup_writers=writers)
'''


class FaultDriverTests(unittest.TestCase):
    def invoke(self, case, action):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        barrier = Path(temporary.name) / 'barrier.json'
        original = SOURCE + ('\ndef main():\n    ' + action + '\n    return 0\n').encode()
        code = fault.instrument(original, case, barrier)
        namespace = {'__file__': str(Path(temporary.name) / 'restore_maintenance.py')}
        with patch.object(os, 'kill') as kill, patch.object(sys, 'argv', ['restore_maintenance.py', 'begin', 'a' * 32]):
            try:
                exec(compile(code, namespace['__file__'], 'exec'), namespace)
            except SystemExit as result:
                self.assertEqual(result.code, 0)
            except Exception as error:
                self.assertIsInstance(error, namespace['m'].storage.StorageError)
            calls = kill.call_args_list
        return namespace['m'].events, json.loads(barrier.read_text()) if barrier.exists() else None, calls

    def test_sigstop_follows_the_real_durable_write(self):
        for case, phase in [('staged', 'STORAGE_STAGED'), ('db-restored', 'DB_RESTORED'),
                            ('reconciled', 'RECONCILED'), ('ready-before-clear', 'READY')]:
            with self.subTest(case=case):
                events, barrier, calls = self.invoke(case, 'write_receipt(None,{"phase":' + repr(phase) + '})')
                self.assertEqual(events, ['durable:' + phase])
                self.assertEqual(barrier['point'], phase)
                self.assertEqual(calls[0].args, (os.getpid(), signal.SIGSTOP))

    def test_unrelated_checkpoint_never_pauses(self):
        events, barrier, calls = self.invoke('staged', 'write_receipt(None,{"phase":"INHIBITED"})')
        self.assertEqual(events, ['durable:INHIBITED'])
        self.assertIsNone(barrier)
        self.assertEqual(calls, [])

    def test_partial_failure_stops_two_real_services_before_raising(self):
        events, barrier, calls = self.invoke('partial-stop', 'storage.release_compose("stop","--timeout","60","ingress","frontend","backend")')
        self.assertEqual(events, [['stop', '--timeout', '60', 'ingress', 'frontend']])
        self.assertEqual(barrier['point'], 'PARTIAL_STOPPED')
        self.assertEqual(calls, [])

    def test_clear_window_follows_actual_inhibitor_removal(self):
        events, barrier, calls = self.invoke('ready-after-clear', 'storage.verify_backup_inhibitor(None,clear=True)')
        self.assertEqual(events, ['clear'])
        self.assertEqual(barrier['point'], 'READY_AFTER_CLEAR')
        self.assertEqual(calls[0].args[1], signal.SIGSTOP)

    def test_foreign_writer_records_and_propagates_original_refusal(self):
        events, barrier, calls = self.invoke('foreign-writer', 'storage.verify_backup_writers(None)')
        self.assertEqual(barrier['point'], 'FOREIGN_WRITER_REFUSED')
        self.assertEqual(calls, [])

    def test_controller_refuses_host_before_commands(self):
        with patch.object(fault, 'command') as command:
            with self.assertRaisesRegex(ValueError, 'disposable root runtime'):
                fault.guard('staged', Path('/tmp'))
        command.assert_not_called()

    def test_unknown_case_cannot_create_instrumentation(self):
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            fault.instrument(SOURCE, 'unknown', Path('/tmp/must-not-exist'))

    def test_negative_start_requires_a_new_actual_process_attempt(self):
        def inspect(start):
            return SimpleNamespace(stdout=json.dumps([{'State': {'StartedAt': start, 'Running': False, 'Status': 'exited', 'ExitCode': 1}}]))
        for started, allowed in [('new', True), ('old', False)]:
            with self.subTest(started=started), patch.object(fault, 'command', side_effect=[
                    inspect('old'), SimpleNamespace(returncode=1), inspect(started)]):
                if allowed:
                    fault.verify_inhibited_start('a' * 64)
                else:
                    with self.assertRaisesRegex(ValueError, 'No new backend process'):
                        fault.verify_inhibited_start('a' * 64)


if __name__ == '__main__':
    unittest.main()
