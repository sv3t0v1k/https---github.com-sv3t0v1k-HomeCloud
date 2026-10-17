#!/bin/sh
set -eu
scanner=${1:?Specify checksum-verified Trivy binary}
source_kind=${2:?Specify remote, docker, or archive}
reference=${3:?Specify immutable base reference or disposable local image}
report=${4:?Specify JSON report destination}
mode=${5:-strict}
[ "$#" -le 5 ] || exit 1
case "$source_kind" in remote|docker|archive) ;; *) exit 1 ;; esac
case "$mode" in strict|diagnostic) ;; *) exit 1 ;; esac
# Diagnostic mode is explicit and reserved for retained raw-base baselines.
cache_dir="$(dirname "$scanner")/cache"
# Include all severities and both OS/language packages in the retained report.
# No ignore-unfixed, ignore file, policy exceptions, secret scan, or daemon mutation.
if [ "$source_kind" = archive ]; then
  reference=$(python3 "$(dirname "$0")/oci-scan-binding.py" --prepare-layout --archive "$reference")
  set -- --input "$reference"
else
  set -- --image-src "$source_kind" "$reference"
fi
"$scanner" --cache-dir "$cache_dir" image --config /dev/null --platform linux/amd64 \
  --scanners vuln --list-all-pkgs --ignore-unfixed=false --ignorefile /dev/null --timeout 15m --no-progress \
  --format json --output "$report" "$@"
python3 "$(dirname "$0")/scan-evidence.py" "$report" "$cache_dir/db/metadata.json" "$source_kind" "$reference"
if [ "$mode" = diagnostic ]; then
  python3 "$(dirname "$0")/scan-policy.py" "$report" --diagnostic
else
  python3 "$(dirname "$0")/scan-policy.py" "$report"
fi
