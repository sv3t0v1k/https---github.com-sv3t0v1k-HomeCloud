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
                "git", "log", "--full-history", "--all", "--format=%H", "--",
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



class RealMergeHistoryTests(unittest.TestCase):
    def test_deleted_file_in_merged_side_branch_blocks(self):
        import os

        env = dict(os.environ)
        env.update({
            "GIT_AUTHOR_NAME": "HomeCloud CI",
            "GIT_AUTHOR_EMAIL": "ci@example.invalid",
            "GIT_COMMITTER_NAME": "HomeCloud CI",
            "GIT_COMMITTER_EMAIL": "ci@example.invalid",
            "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+0000",
            "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+0000",
        })

        def git(*args, data=None):
            return subprocess.run(
                ["git", *args],
                input=data,
                text=True,
                capture_output=True,
                check=True,
                env=env,
            ).stdout.strip()

        # Synthetic unreachable objects in the existing repository.
        # No branches, refs, checkout, worktrees or test directories.
        empty = git("mktree", data="")
        audit = git(
            "hash-object", "-w", "--stdin",
            data="Synthetic audit fixture\n",
        )
        canary = git(
            "hash-object", "-w", "--stdin",
            data="Synthetic scan-scope canary\n",
        )

        tests_tree = git(
            "mktree",
            data=f"100644 blob {audit}\tPHASE-5.3.1-TEST-AUDIT.md\n",
        )
        scripts_tree = git(
            "mktree",
            data=(
                f"100644 blob {canary}\tci-history-canary.txt\n"
                f"040000 tree {tests_tree}\ttests\n"
            ),
        )
        side_tree = git(
            "mktree",
            data=f"040000 tree {scripts_tree}\tscripts\n",
        )

        root = git("commit-tree", empty, "-m", "Synthetic root")
        added = git(
            "commit-tree", side_tree,
            "-p", root, "-m", "Side add",
        )
        deleted = git(
            "commit-tree", empty,
            "-p", added, "-m", "Side delete",
        )
        merge = git(
            "commit-tree", empty,
            "-p", root, "-p", deleted,
            "-m", "Synthetic merge",
        )

        with self.assertRaisesRegex(
            ValueError, "FORBIDDEN_PATH_REACHABLE"
        ):
            guard.verify(revision=merge)

        # Verify Gitleaks' Git pathspec also reaches the side branch.
        scanned = git(
            "log", "--full-history", merge,
            "--format=%H", "--", ".",
            ":(exclude)" + guard.FORBIDDEN,
        ).splitlines()

        self.assertIn(
            added, scanned,
            "Side branch was omitted from secret-scan scope",
        )


if __name__ == "__main__":
    unittest.main()
