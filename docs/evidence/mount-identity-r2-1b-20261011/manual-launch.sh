#!/bin/sh
set -eu
# Owner invokes this once. Password stays in sudo's local terminal prompt.
sudo /usr/bin/python3 -I - <<'PY'
import hashlib
import os
import stat

path='/home/hs/homecloud-test/r2-1b-20261011-01a12a22/isolated-helper.py'
expected='8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426'
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
s=os.fstat(fd)
if not (stat.S_ISREG(s.st_mode) and s.st_uid==1000 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=65536):
    os.close(fd)
    raise SystemExit('STOP: helper source owner/type/mode/size mismatch')
with os.fdopen(fd,'rb') as f:
    raw=f.read(65537)
if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=expected:
    raise SystemExit('STOP: helper SHA256 mismatch')
SOURCE=raw.decode('utf-8')
ENTRY='parent'
exec(compile(SOURCE,'<sha256-verified-helper>','exec'))
PY
