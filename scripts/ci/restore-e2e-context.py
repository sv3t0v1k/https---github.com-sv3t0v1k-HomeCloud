#!/usr/bin/env python3
"""Build only the disposable E2E source context with Linux trust metadata."""
import io
import os
from pathlib import Path
import stat
import sys
import tarfile


DOCKERFILE = b'''FROM homecloud-restore-e2e-runner:local
USER 0:0
WORKDIR /opt/homecloud
COPY --chown=0:0 . /opt/homecloud/
RUN chmod 0755 /opt /opt/homecloud && find /opt/homecloud -type d -exec chmod 0755 {} +
RUN python3 -B scripts/ci/restore-runtime-preflight.py
ENTRYPOINT ["bash", "/opt/homecloud/scripts/ci/test-restore-e2e-local.sh"]
'''


def write_context(output, root, extra_paths=(), dockerfile=DOCKERFILE):
    root = Path(root).resolve(strict=True)
    paths = {
        Path("backend/package.json"),
        Path("scripts/ci/test-restore-e2e-local.sh"),
        Path("scripts/ci/restore-runtime-preflight.py"),
        Path("scripts/ci/restore-e2e-cgroup.py"),
        Path("scripts/ci/test-historical-schema-e2e.py"),
        Path("scripts/ci/historical-schema-producer.cjs"),
        Path("scripts/ci/test-restore-fault-e2e.py"),
    }
    paths.update(Path(path) for path in extra_paths)
    if any(path.is_absolute() or ".." in path.parts for path in paths):
        raise ValueError("Context paths must remain relative to the repository")
    for folder in ("scripts", "deploy/linux"):
        directory = root / folder
        if directory.resolve(strict=True) != directory:
            raise ValueError("Source directory symlink refused")
        paths.update(path.relative_to(root) for path in directory.iterdir()
                     if path.is_file() and path.suffix in (".py", ".sh", ".sql"))
    directories = set()
    for relative in paths:
        directories.update(parent for parent in relative.parents if parent != Path("."))

    with tarfile.open(fileobj=output, mode="w|") as archive:
        entry = tarfile.TarInfo("Dockerfile")
        entry.size, entry.mode = len(dockerfile), 0o644
        archive.addfile(entry, io.BytesIO(dockerfile))
        for relative in sorted(directories, key=lambda path: (len(path.parts), str(path))):
            path = root / relative
            if path.resolve(strict=True) != path or not path.is_dir():
                raise ValueError("Noncanonical source directory refused")
            entry = tarfile.TarInfo(str(relative))
            entry.type, entry.mode = tarfile.DIRTYPE, 0o755
            archive.addfile(entry)
        for relative in sorted(paths):
            path = root / relative
            if path.resolve(strict=True) != path or path.is_symlink():
                raise ValueError("Source symlink refused")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("Regular source with one link required")
                entry = tarfile.TarInfo(str(relative))
                entry.size = info.st_size
                entry.mode = 0o755 if info.st_mode & 0o111 else 0o644
                # TarInfo defaults: numeric uid/gid 0, empty uname/gname.
                # Never inherit the Mac uid/gid, ACLs, xattrs or write bits.
                archive.addfile(entry, source)


if __name__ == "__main__":
    write_context(sys.stdout.buffer, Path.cwd())
