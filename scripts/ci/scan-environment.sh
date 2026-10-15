#!/bin/sh
# Capture the environment that actually ran the job; never run against a developer host.
set -eu
scanner=${1:?Specify checksum-verified Trivy binary}
environment_id=${2:?Specify environment ID}
component=${3:?Specify backend, frontend, or none}
output=${4:?Specify evidence directory}
registry=${5:-}
[ "${GITHUB_ACTIONS:-}" = true ] && [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
  echo 'Environment scans require a GitHub Actions Linux amd64 job' >&2; exit 1;
}
case "$component" in backend|frontend|none) ;; *) exit 1 ;; esac
workspace=$(git -c "safe.directory=$GITHUB_WORKSPACE" rev-parse --show-toplevel)
workspace=$(realpath "$workspace")
[ "$workspace" != / ] || exit 1
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cache_dir="$(dirname "$scanner")/cache"
mkdir -p "$output"
output=$(realpath "$output")
# The checkout is excluded BEFORE traversal. Its only scanned portion is an
# explicitly selected application directory. No audit/document subtree is read.
# Ephemeral mounts/temp directories do not represent installed OS packages.
# /opt (including setup-node toolcache), /usr and global npm packages stay included.
skip_dirs="/proc,/sys,/dev,/run,/tmp,/var/tmp,/var/lib/docker,/var/lib/containerd,$workspace,$output,$cache_dir"
for excluded in "${GITHUB_WORKSPACE:-$workspace}" "${RUNNER_TEMP:-/tmp}"; do
  skip_dirs="$skip_dirs,$excluded,$(realpath "$excluded")"
done
python3 "$script_dir/environment-evidence.py" capture "$environment_id" "$component" "$workspace" "$output" "$skip_dirs" "$scanner" "$registry"
status=0
"$scanner" --cache-dir "$cache_dir" rootfs --config /dev/null \
  --skip-dirs "$skip_dirs" --scanners vuln --ignore-unfixed=false --ignorefile /dev/null \
  --list-all-pkgs --parallel 0 --timeout 60m --no-progress --format json \
  --output "$output/rootfs.json" / > "$output/rootfs.log" 2>&1 || status=1
if [ "$component" != none ]; then
  "$scanner" --cache-dir "$cache_dir" rootfs --config /dev/null \
    --scanners vuln --ignore-unfixed=false --ignorefile /dev/null \
    --list-all-pkgs --parallel 0 --timeout 20m --no-progress --format json \
    --output "$output/component.json" "$workspace/$component/node_modules" > "$output/component.log" 2>&1 || status=1
fi
"$scanner" --cache-dir "$cache_dir" rootfs --config /dev/null \
  --scanners vuln --ignore-unfixed=false --ignorefile /dev/null \
  --list-all-pkgs --parallel 0 --timeout 15m --no-progress --format json \
  --output "$output/tools.json" "$output/executed-tools" > "$output/tools.log" 2>&1 || status=1
# Always finish every required scan and retain evidence before enforcing severity.
python3 "$script_dir/environment-evidence.py" validate "$output" "$cache_dir/db/metadata.json" || status=1
python3 "$script_dir/scan-policy.py" "$output/rootfs.json" --environment || status=1
python3 "$script_dir/scan-policy.py" "$output/tools.json" --component || status=1
if [ "$component" != none ]; then
  python3 "$script_dir/scan-policy.py" "$output/component.json" --component || status=1
fi
exit "$status"
