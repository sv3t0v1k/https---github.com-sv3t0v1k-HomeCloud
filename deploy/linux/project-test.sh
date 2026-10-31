#!/bin/sh
# Только собственный project; сборка/подготовка mounts/secrets выполняется отдельно.
set -eu
fail() { echo 'STOP: project-test wrapper' >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail
[ "$#" = 1 ] || fail
case "$1" in preflight|config|start|status|stop|test-baseline-inspect|test-recovery-inspect|test-dry-run|test-apply|test-rollback) action=$1;; *) fail;; esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || fail
project_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P) || fail
cd -- "$project_root" || fail
clean_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
preflight() {
  env -i HOME=/root PATH="$clean_path" python3 "$project_root/deploy/linux/preflight.py" \
    --inventory "$project_root/.runtime/host-disks.json" \
    --env-file "$project_root/.runtime/runtime.env"
}
compose() {
  env -i HOME=/root PATH="$clean_path" docker --host unix:///var/run/docker.sock compose \
    --project-directory "$project_root" --env-file "$project_root/.runtime/runtime.env" \
    -f "$project_root/docker-compose.yml" \
    -f "$project_root/docker-compose.production.yml" \
    -f "$project_root/docker-compose.project-test.yml" "$@"
}
case "$action" in
  preflight) preflight;;
  config) compose config --quiet;;
  start)
    preflight
    compose up -d --no-build --pull never --wait db backend frontend ingress
    ;;
  status) compose ps --all;;
  stop) compose stop db backend frontend ingress;;
  test-baseline-inspect|test-recovery-inspect|test-dry-run|test-apply|test-rollback)
    mode=${action#test-}
    env -i HOME=/root PATH="$clean_path" python3 "$project_root/deploy/linux/test-channel.py" "$mode"
    ;;
esac
