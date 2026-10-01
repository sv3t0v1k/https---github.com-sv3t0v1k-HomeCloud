# Неизменяемый manifest релиза и откат пары

Ненумерованный bounded checkpoint. Общий Production Readiness остаётся **NOT_READY / NO_GO**. Этот контракт квалифицирует локальные Docker artifacts и app rollback пары, не production registry, новый домен или запуск публичного трафика.

## Контракт

`scripts/release-manifest.cjs` создаёт JSON `homecloud-release-v1`. Он связывает source commit, backend/frontend полные `sha256:` image IDs, source tree checksum, checksum production Compose, список migration names/classes/hashes и entity/data-source hashes. `release_id` — SHA256 содержимого без timestamps. Manifest не содержит environment/config secret values.

Production builds выполняются из чистого exact-commit `git archive`, стандартными backend/frontend Dockerfiles с lockfile `npm ci`. Каждый образ получает labels `org.opencontainers.image.revision=COMMIT`, `io.homecloud.role=backend|frontend`, `io.homecloud.pair=COMMIT`. Labels — утверждения доверенного builder, не криптографическая подпись. Build provenance проверяется архивом и build evidence; manifest checksum не доказывает авторство. Mutable base tags не позволяют обещать bit-for-bit rebuild: удерживать квалифицированные immutable outputs.

```bash
node scripts/release-manifest.cjs generate --source-root "$RELEASE_SOURCE" --source-commit "$RELEASE_COMMIT" --backend "$BACKEND_IMAGE_ID" --frontend "$FRONTEND_IMAGE_ID" --output "$CURRENT_MANIFEST"
node scripts/release-manifest.cjs validate --manifest "$CURRENT_MANIFEST" --source-root "$RELEASE_SOURCE" --source-commit "$RELEASE_COMMIT"
```

Source root — исходный чистый checkout или archive, не deployment checkout с незакоммиченными изменениями. У archive commit передаётся явно: сам archive не доказывает связь с Git. Archive/export и builder входят в доверенную границу. Нет автоматического поиска пары по tags; отсутствующий образ блокирует validation. Source hashes не содержат секреты и не заменяют проверки trusted build path.

## Schema guard и operator sequence

До app rollback закрыть внешний maintenance barrier, завершить записи и остановить frontend/backend. DB/storage остаются на месте. Из DB снять свежий JSON array `migrations.name`, сопоставить current manifest с реально установленным backend/frontend, проверить no pending migrations текущим и предыдущим backend image. На новой установке reviewed migrations применяются current backend до app запуска по [release runbook](./release-and-rollback.md).

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT coalesce(json_agg(name ORDER BY name), '\''[]'\''::json) FROM migrations"' > "$APPLIED_MIGRATIONS"
node scripts/release-manifest.cjs override --manifest "$PREVIOUS_MANIFEST" --source-root "$PREVIOUS_SOURCE" --source-commit "$PREVIOUS_COMMIT" --compatibility-manifest "$CURRENT_MANIFEST" --applied-migrations "$APPLIED_MIGRATIONS" --output "$RELEASE_IMAGES"
```

Guard требует полного совпадения migration content, entity/data-source mappings и точного списка applied migration classes. Missing/pending/extra/duplicate classes, изменение marker или source/role/pair/ID блокируют откат. Это консервативный отказ при любых изменениях schema contract; ручного bypass или автоматического `migration:revert` нет. Снимок applied names сам по себе не обнаруживает ручной DDL drift: после согласованных migrations запрещены внепроцедурные schema edits; при drift нужен отдельный review/recovery decision.

Generated YAML override требует Compose с поддержкой `!reset`; неподдерживаемая версия должна остановиться на config validation. JSON null не удаляет inherited build context. Generated override содержит оба IDs, `build: !reset null`, `pull_policy: never` и release label. Подключить его последним к тому же Compose project и volume names; проверить resolved config без печати секретов. Не редактировать один ID вручную.

```bash
export COMPOSE_FILE="$RELEASE_SOURCE/docker-compose.production.yml:$RELEASE_IMAGES"
docker compose config --quiet
docker compose up -d --no-build --no-deps backend
# internal readiness200 и no pending migrations
docker compose up -d --no-build --no-deps frontend
docker inspect --format '{{.Image}}' "$(docker compose ps -q backend)"
docker inspect --format '{{.Image}}' "$(docker compose ps -q frontend)"
# Сверить оба значения с выбранным manifest; затем ingress/UI/API/data smoke
```

Для rollout после migrations используется тот же override с current manifest как `--manifest` и `--compatibility-manifest`. DB rollback — отдельная разрушительная процедура paired restore, никогда не часть app rollback. Не удалять volumes. Ошибка validation не запускает Compose; уже созданный override при отказе нельзя использовать.

## Distribution boundary

Локальный image ID — hash image configuration/content graph, не registry manifest digest. Production distribution должна отдельно push оба проверенных artifacts, зафиксировать каждый `repository@sha256:registry-manifest-digest`, pull на target, проверить platform-specific local image IDs/provenance и сохранить связь этих refs с квалифицированным manifest. Registry/multi-platform manifest и target pull не квалифицированы этой задачей; текущий helper поддерживает только local-image-id и не принимает registry refs вместо IDs. Qualified manifests и outputs сохранять вне transient host state по operator custody policy. Registry deployment не выполнен.

## Воспроизводимый drill

`python3 scripts/tests/release-pair-runtime.py` строит обе пары из exact-commit archives; создаёт только свои networks/containers/storage; current migration apply → ingress/API/data fixture → controlled app outage → previous immutable pair → rollforward. Сохраняет sanitized JSON, manifests и фактические image IDs. TLS — disposable self-signed certificate; случайные изолированные сети с fixture trusted proxy, не qualification production fixed subnets/DNS/CA/native bind. UI static responses/assets и API flows не заменяют desktop/mobile browser acceptance.

Previous `647aa7b949698f9b84feee3ce5134cb2a7b542de` — предыдущий known-good security checkpoint, current `37b2eae7f8375a01c0b7207f70317c57ee3ae01d`. Application trees одинаковы: доказано переключение двух различных immutable release outputs с разной provenance, не поведение разных application versions и не backward compatibility изменённой схемы. Это сознательный выбор после исправления Router; уязвимую старую frontend version не возвращаем как production rollback recommendation.


Финальное qualification evidence: [current manifest](./evidence/immutable-release/current-manifest.json), [previous manifest](./evidence/immutable-release/previous-manifest.json), [переходы и snapshots](./evidence/immutable-release/qualification.json). Оба IDs реально переключились, rollback и rollforward PASS; qualified local outputs удержаны. Raw logs/source contexts временные, sanitized evidence сохранено в repo. INDEPENDENT_REVIEW: APPROVE. Reviewer не автор: actual final code/docs/raw evidence проверены; focused32/32 и обе actual Docker manifest/source validation PASS, diff-check PASS. Sanitized evidence сверено с raw, оба сохранённых manifest byte-identical originals.
