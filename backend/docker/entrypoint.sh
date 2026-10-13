#!/bin/sh
set -eu
# Только обычный API startup выполняет миграции. D1 helper sh/node и операторский
# npm run migration:run исполняются напрямую, без скрытой подготовки или записи.
if [ "$#" -eq 2 ] && [ "$1" = node ] && [ "$2" = dist/main.js ]; then
  # TypeORM synchronize выключен; additive migrations выполняются в transaction all.
  # Один backend-процесс. При обновлении writers должны быть остановлены оператором.
  npm run migration:run -- --transaction all
fi
exec "$@"
