#!/bin/sh
set -eu
# API и поддерживаемые операторские миграции проходят root fence.
# Offline recovery имеет собственную эксклюзивную блокировку.
# Остальные D1 helper-команды не запускают неявные миграции.
if [ "$#" -eq 2 ] && [ "$1" = node ] && [ "$2" = dist/main.js ]; then
  # One exclusive root lock spans migrations and the API lifetime.
  exec node docker/copy-root-fence-supervisor.cjs
fi

# All supported TypeORM operator CLI calls must use the same
# kernel lock as the live API. Unsupported actions fail closed.
if [ "$#" -ge 3 ] && [ "$1" = node ]; then
  case "$2" in
    ./node_modules/typeorm/cli.js|node_modules/typeorm/cli.js)
      exec node docker/copy-root-fence-supervisor.cjs --operator-cli "$@"
      ;;
  esac
fi

exec "$@"
