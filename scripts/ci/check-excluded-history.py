#!/usr/bin/env python3
"""Проверить исключённый путь без чтения его содержимого."""

import subprocess
import sys

FORBIDDEN = "scripts/tests/PHASE-5.3.1-TEST-AUDIT.md"


def verify(run=subprocess.run):
    def git(*args):
        result = run(
            ["git", *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    if git("rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("SHALLOW_HISTORY")

    if not git("for-each-ref", "--format=%(refname)"):
        raise ValueError("MISSING_REFS")

    history = git(
        "log",
        "--all",
        "--format=%H",
        "--",
        ":(literal)" + FORBIDDEN,
    )

    if history:
        raise ValueError("FORBIDDEN_PATH_REACHABLE")

    return True


def main():
    try:
        verify()
    except (OSError, subprocess.SubprocessError, ValueError):
        print("BLOCKER: excluded Git history is not qualified",
              file=sys.stderr)
        return 1

    print("PASS: excluded path absent from reachable history")
    return 0


if __name__ == "__main__":
    sys.exit(main())
