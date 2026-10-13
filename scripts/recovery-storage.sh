# Shared verified backend storage; configuration must already be loaded.
recovery_storage_resolve() {
  local assignments
  assignments="$(python3 "$SCRIPT_DIR/recovery_storage.py" resolve)" || return 1
  eval "$assignments"
}
recovery_storage_check() {
  python3 "$SCRIPT_DIR/recovery_storage.py" check
}
# MODE [--user root] [-i] [--entrypoint sh] -- IMAGE COMMAND...
recovery_storage_run() {
  python3 "$SCRIPT_DIR/recovery_storage.py" run "$@"
}

recovery_storage_image() {
  python3 "$SCRIPT_DIR/recovery_storage.py" image "$1"
}

# Existing swap/staging may hold the only surviving copy after a failed restore.
# Refuse automated retries instead of guessing ownership and deleting artifacts.
recovery_storage_assert_clean() {
  recovery_storage_run ro -- "$BACKEND_IMAGE" sh -c '
    for name in .restore-staging .restore-swap; do
      if [ -e "$1/$name" ] || [ -L "$1/$name" ]; then
        echo "ERROR: retained restore artifacts require operator review" >&2
        exit 1
      fi
    done
  ' recovery-storage "$RECOVERY_STORAGE_TARGET"
}
