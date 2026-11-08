#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import subprocess
import unittest

path = Path(__file__).with_name("check-excluded-history.py")
spec = importlib.util.spec_from_file_location("history_guard", path)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class HistoryGuardTests(unittest.TestCase):
    def invoke(self, shallow="false",
               refs="refs/heads/test", history=""):
        outputs = iter((shallow, refs, history))
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            self.assertTrue(kwargs["check"])
            return subprocess.CompletedProcess(
                args, 0, stdout=next(outputs)
            )

        return guard.verify(fake_run), calls

    def test_full_clean_history_passes(self):
        passed, calls = self.invoke()
        self.assertTrue(passed)
        self.assertEqual(
            calls[-1],
            [
                "git", "log", "--all", "--format=%H", "--",
                ":(literal)" + guard.FORBIDDEN,
            ],
        )

    def test_excluded_path_in_history_blocks(self):
        with self.assertRaises(ValueError):
            self.invoke(history="a" * 40)

    def test_shallow_history_blocks(self):
        with self.assertRaises(ValueError):
            self.invoke(shallow="true")

    def test_missing_refs_blocks(self):
        with self.assertRaises(ValueError):
            self.invoke(refs="")

    def test_git_error_blocks(self):
        def failure(args, **kwargs):
            raise subprocess.CalledProcessError(128, args)

        with self.assertRaises(subprocess.CalledProcessError):
            guard.verify(failure)


if __name__ == "__main__":
    unittest.main()
