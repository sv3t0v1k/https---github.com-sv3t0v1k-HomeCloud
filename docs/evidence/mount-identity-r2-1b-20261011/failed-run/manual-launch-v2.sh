#!/bin/sh
set -eu
# Owner invokes once: guarded own-loop recovery, then fresh isolated research.
sudo /usr/bin/python3 -I - <<'PY'
import hashlib
import os
import stat

base='/home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22/'
expected={
 'recover-owned-loop.py':'6d4dda1208c259c9ad22856dd362496ee8f975630091a03a9eed29e711bfb21c',
 'isolated-helper-v2.py':'5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49',
}
sources={}
for name,digest in expected.items():
    fd=os.open(base+name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    s=os.fstat(fd)
    if not (stat.S_ISREG(s.st_mode) and s.st_uid==1000 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=65536):
        os.close(fd)
        raise SystemExit('STOP: source owner/type/mode/size mismatch')
    with os.fdopen(fd,'rb') as f: raw=f.read(65537)
    if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=digest:
        raise SystemExit('STOP: source SHA256 mismatch')
    sources[name]=raw.decode('utf-8')

# Both sources pinned and SHA-verified before the sole recovery mutation.
recovery={'__name__':'verified_recovery'}
exec(compile(sources['recover-owned-loop.py'],'<verified-recovery>','exec'),recovery)
recovery['recover']()
SOURCE=sources['isolated-helper-v2.py']
ENTRY='parent'
exec(compile(SOURCE,'<verified-v2-helper>','exec'))
PY
