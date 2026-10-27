#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
check="$root/scripts/backup-dump-structure.sh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/homecloud-backup-dump.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT

python3 - "$fixture" <<'PY'
import gzip
from pathlib import Path
import sys

root = Path(sys.argv[1])
padding = b'-- a long SQL dump line\n' * 100000
with gzip.open(root / 'valid.sql.gz', 'wb') as output:
    output.write(b'CREATE TABLE public.files (id integer);\n' + padding)
with gzip.open(root / 'missing-ddl.sql.gz', 'wb') as output:
    output.write(b'-- no schema statements\n' + padding)
contents = (root / 'valid.sql.gz').read_bytes()
(root / 'corrupt.sql.gz').write_bytes(contents[:-8])
PY

bash "$check" "$fixture/valid.sql.gz"
if bash "$check" "$fixture/missing-ddl.sql.gz" >/dev/null 2>&1; then
    echo 'FAIL: dump without DDL accepted' >&2
    exit 1
fi
if bash "$check" "$fixture/corrupt.sql.gz" >/dev/null 2>&1; then
    echo 'FAIL: corrupt gzip accepted' >&2
    exit 1
fi

echo 'PASS: long early-DDL dump, no DDL and corrupt gzip'
