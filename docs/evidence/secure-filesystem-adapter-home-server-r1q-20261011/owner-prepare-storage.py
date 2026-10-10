#!/usr/bin/env python3
"""Owner-only step: create one empty test directory; never alter an existing path."""
import grp
import os
import pwd
import stat
import subprocess

if os.geteuid() != 0:
    raise SystemExit("Run locally on home-server: sudo python3 owner-prepare-storage.py")
account = pwd.getpwnam("hs")
group = grp.getgrnam("hs")
if (account.pw_uid, group.gr_gid) != (1000, 1000):
    raise SystemExit("STOP: hs identity differs from recorded baseline")
mount = subprocess.check_output(
    ["findmnt", "-rn", "-T", "/mnt/1TB", "-o", "TARGET,SOURCE,FSTYPE"], text=True
).split()
if mount != ["/mnt/1TB", "/dev/sdc1", "ext4"]:
    raise SystemExit("STOP: mount identity differs from recorded baseline")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
fds = []
try:
    fd = os.open("/", flags)
    fds.append(fd)
    for component in ("mnt", "1TB"):
        fd = os.open(component, flags, dir_fd=fd)
        fds.append(fd)
    device = os.stat("/dev/sdc1", follow_symlinks=False)
    parent = os.fstat(fd)
    if not stat.S_ISBLK(device.st_mode) or parent.st_dev != device.st_rdev:
        raise SystemExit("STOP: opened parent is not recorded mount")
    if parent.st_uid != 0 or parent.st_mode & 0o022:
        raise SystemExit("STOP: storage parent ownership or permissions changed")
    # mkdir is exclusive. Existing directories, files and symlinks all cause refusal.
    os.mkdir("homecloud-test", 0o700, dir_fd=fd)
    child = os.open("homecloud-test", flags, dir_fd=fd)
    fds.append(child)
    os.fchown(child, account.pw_uid, group.gr_gid)
    os.fchmod(child, 0o700)
    os.fsync(child)
    os.fsync(fd)
    print("CREATED /mnt/1TB/homecloud-test owner=hs:hs mode=0700; empty; no Docker changes")
finally:
    for fd in reversed(fds):
        os.close(fd)
