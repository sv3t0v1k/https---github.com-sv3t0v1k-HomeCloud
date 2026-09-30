#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 0 ] || { echo '{"event":"backup_production_failed","stage":"arguments"}' >&2; exit 2; }
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-production.py" backup
