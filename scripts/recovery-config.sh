# Shared explicit loader. Quoted assignments only; file content is never sourced.
set +x
recovery_assignments="$(python3 "$SCRIPT_DIR/recovery_config.py")" || exit 2
eval "$recovery_assignments"
unset recovery_assignments
# Every nested Compose call disables automatic dotenv discovery.
docker() {
  if [ "${1:-}" = compose ]; then
    shift
    command docker compose --env-file /dev/null "$@"
  else
    command docker "$@"
  fi
}
