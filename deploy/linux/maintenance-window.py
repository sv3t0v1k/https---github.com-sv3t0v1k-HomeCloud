#!/usr/bin/env python3
"""Fail-closed maintenance coordination library.

Order:
1. Persist startup inhibitor.
2. Stop application writers.
3. Acquire the exclusive storage-root flock.
4. Verify writers are stopped.
5. Execute the critical section under flock.

Never removes the durable inhibitor automatically.
"""

from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path


class MaintenanceWindowError(Exception):
    pass


def load_helper(filename, module_name):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(
        module_name, path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inhibitor = load_helper(
    "maintenance-inhibit.py",
    "homecloud_maintenance_inhibit",
)
fencing = load_helper(
    "storage-writer-fence.py",
    "homecloud_storage_writer_fence",
)


@contextmanager
def maintenance_window(
    storage_root,
    state_root,
    *,
    expected_storage_uid,
    stop_writers,
    verify_stopped,
    expected_state_uid=0,
):
    """Keep root lock for the complete critical operation.

    Callbacks must return exactly True on verified success.
    Exceptions, False, and competing locks fail closed.

    A failed or completed operation leaves the inhibitor present.
    Only a separate audited operator reconciliation may clear it.
    """
    if not callable(stop_writers) or not callable(verify_stopped):
        raise MaintenanceWindowError(
            "Maintenance callbacks are required"
        )

    # This must be durable BEFORE requesting writer shutdown.
    inhibitor.assert_operation_allowed(state_root, expected_state_uid)
    inhibitor.create_inhibit(
        state_root, expected_state_uid
    )

    # Any failure from here retains the startup inhibitor.
    if stop_writers() is not True:
        raise MaintenanceWindowError(
            "Writer shutdown was not confirmed"
        )

    fd = fencing.acquire_storage_root_fence(
        storage_root, expected_storage_uid
    )

    try:
        if verify_stopped() is not True:
            raise MaintenanceWindowError(
                "Writer absence was not verified"
            )

        # The exclusive FD remains open during the entire body.
        yield
    finally:
        os.close(fd)
