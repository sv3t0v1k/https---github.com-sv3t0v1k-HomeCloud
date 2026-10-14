#!/bin/sh
set -eu
# Только обычный API startup выполняет миграции. D1 helper sh/node и операторский
# node ./node_modules/typeorm/cli.js исполняются напрямую, без скрытой подготовки.
if [ "$#" -eq 2 ] && [ "$1" = node ] && [ "$2" = dist/main.js ]; then
  # TypeORM synchronize выключен; additive migrations выполняются в transaction all.
  # Один backend-процесс. При обновлении writers должны быть остановлены оператором.
  node ./node_modules/typeorm/cli.js migration:run -d dist/data-source.js --transaction all
fi
exec "$@"
