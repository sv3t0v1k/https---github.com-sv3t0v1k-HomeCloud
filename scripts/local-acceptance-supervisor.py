#!/usr/bin/env python3
"""Bound local acceptance runtime and terminate its child process group."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

TOTAL_TIMEOUT_SECONDS = 60 * 60
TERMINATE_GRACE_SECONDS = 10


def signal_group(process: subprocess.Popen[bytes], signum: int) -> None:
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def stop_group(process: subprocess.Popen[bytes], signum: int) -> None:
    signal_group(process, signum)
    deadline = time.monotonic() + TERMINATE_GRACE_SECONDS
    while time.monotonic() < deadline:
        process.poll()  # Reap the direct child if it exited on the forwarded signal.
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        signal_group(process, signal.SIGKILL)
    process.wait()


def main() -> int:
    if len(sys.argv) != 2:
        print("Использование: local-acceptance-supervisor.py <script>", file=sys.stderr)
        return 2

    command = ["/bin/sh", sys.argv[1]]
    started = time.monotonic()
    environment = os.environ.copy()
    environment["HOMECLOUD_ACCEPTANCE_SUPERVISED"] = "1"
    child = subprocess.Popen(command, start_new_session=True, env=environment)
    received_signal: int | None = None

    def forward_signal(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = signum
        signal_group(child, signum)

    previous_handlers = {
        signum: signal.signal(signum, forward_signal)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }

    try:
        while child.poll() is None:
            if received_signal is not None:
                break
            remaining = TOTAL_TIMEOUT_SECONDS - (time.monotonic() - started)
            if remaining <= 0:
                print(
                    f"TIMEOUT: локальная приёмка превысила лимит {(TOTAL_TIMEOUT_SECONDS + 59) // 60} минут; завершаю процессы.",
                    file=sys.stderr,
                    flush=True,
                )
                stop_group(child, signal.SIGTERM)
                return 124
            try:
                child.wait(timeout=min(remaining, 1.0))
            except subprocess.TimeoutExpired:
                continue

        if received_signal is not None:
            stop_group(child, signal.SIGTERM)
            return 128 + received_signal
        return_code = child.wait()
        if return_code != 0:
            print(
                f"Приёмка завершилась с кодом {return_code}; завершаю оставшиеся дочерние процессы.",
                file=sys.stderr,
                flush=True,
            )
        stop_group(child, signal.SIGTERM)
        return return_code if return_code >= 0 else 128 - return_code
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
