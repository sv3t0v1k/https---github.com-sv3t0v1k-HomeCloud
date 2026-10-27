#!/usr/bin/env bash
set -euo pipefail

[ "$#" -eq 1 ] || exit 2

# grep without -q reads to EOF; pipefail preserves decompression errors.
gunzip -c "$1" | grep -E 'CREATE TABLE|CREATE EXTENSION' >/dev/null
