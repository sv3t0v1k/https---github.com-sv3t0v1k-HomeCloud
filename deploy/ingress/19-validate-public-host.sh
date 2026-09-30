#!/bin/sh
set -eu
export LC_ALL=C
# Validate before nginx envsubst inserts the canonical lowercase hostname into its config.
printf '%s\n' "${PUBLIC_HOST:-}" | awk '
  NR != 1 { exit 1 }
  length($0) > 253 { exit 1 }
  $0 !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/ { exit 1 }
  { n = split($0, labels, "."); for (i = 1; i <= n; i++) if (length(labels[i]) > 63) exit 1 }
  END { if (NR != 1) exit 1 }
' || { echo "PUBLIC_HOST must be a bare lowercase DNS hostname" >&2; exit 1; }
