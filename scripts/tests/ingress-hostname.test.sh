#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VALIDATOR="$SCRIPT_DIR/../../deploy/ingress/19-validate-public-host.sh"
accept() {
  PUBLIC_HOST="$1" sh "$VALIDATOR" || { echo "Rejected valid hostname" >&2; exit 1; }
}
reject() {
  if PUBLIC_HOST="$1" sh "$VALIDATOR" >/dev/null 2>&1; then
    echo "Accepted invalid hostname" >&2; exit 1
  fi
}
accept homecloud.test
accept localhost
accept home-cloud.example
reject HOME-CLOUD.example
accept 127.0.0.1
reject ''
reject 'bad;host'
reject 'good.test
evil.test'
reject 'good.test
'
reject 'host.test.'
reject '-host.test'
reject 'host-.test'
reject 'host..test'
reject 'host.test:443'
reject 'https://host.test'
reject 'хост.test'
LABEL=$(printf '%064d' 0)
reject "$LABEL.test"
LABEL63=$(printf '%063d' 0)
accept "$LABEL63.test"
reject "$LABEL63.$LABEL63.$LABEL63.$LABEL63"
accept "$LABEL63.$LABEL63.$LABEL63.$(printf '%061d' 0)"
echo "Ingress hostname validation: PASS"
