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

Значение локального image ID зависит от Docker image store: classic хранит config digest, containerd может выдавать manifest/index digest. Нельзя объявлять его registry digest без подтверждения push/Registry API и manifest bytes. Production distribution должна отдельно push оба проверенных artifacts, зафиксировать каждый `repository@sha256:registry-manifest-digest`, pull на target, проверить platform-specific local image IDs/provenance и сохранить связь этих refs с квалифицированным manifest. Прежним локальным checkpoint registry/multi-platform manifest и target pull не квалифицированы; на момент предыдущего локального checkpoint helper поддерживал только local-image-id. Registry extension и новая qualification описаны ниже. Qualified manifests и outputs сохранять вне transient host state по operator custody policy. На момент локального checkpoint registry deployment не выполнялся.

## Воспроизводимый drill

`python3 scripts/tests/release-pair-runtime.py` строит обе пары из exact-commit archives; создаёт только свои networks/containers/storage; current migration apply → ingress/API/data fixture → controlled app outage → previous immutable pair → rollforward. Сохраняет sanitized JSON, manifests и фактические image IDs. TLS — disposable self-signed certificate; случайные изолированные сети с fixture trusted proxy, не qualification production fixed subnets/DNS/CA/native bind. UI static responses/assets и API flows не заменяют desktop/mobile browser acceptance.

Previous `647aa7b949698f9b84feee3ce5134cb2a7b542de` — предыдущий known-good security checkpoint, current `37b2eae7f8375a01c0b7207f70317c57ee3ae01d`. Application trees одинаковы: доказано переключение двух различных immutable release outputs с разной provenance, не поведение разных application versions и не backward compatibility изменённой схемы. Это сознательный выбор после исправления Router; уязвимую старую frontend version не возвращаем как production rollback recommendation.


Финальное qualification evidence: [current manifest](./evidence/immutable-release/current-manifest.json), [previous manifest](./evidence/immutable-release/previous-manifest.json), [переходы и snapshots](./evidence/immutable-release/qualification.json). Оба IDs реально переключились, rollback и rollforward PASS; qualified local outputs удержаны. Raw logs/source contexts временные, sanitized evidence сохранено в repo. INDEPENDENT_REVIEW: APPROVE. Reviewer не автор: actual final code/docs/raw evidence проверены; focused32/32 и обе actual Docker manifest/source validation PASS, diff-check PASS. Sanitized evidence сверено с raw, оба сохранённых manifest byte-identical originals.


## Registry digest contract

`homecloud-release-v1` поддерживает `distribution: registry-digest` наряду с прежним `local-image-id`. Каждая запись images содержит строго `repository,digest,source_commit,role,pair`; deploy identity — `repository@sha256:…`, локальный config image ID не входит в distributed manifest. Общий release_id охватывает обе записи и прежний schema/source/Compose contract. Manifest не содержит auth. Repository требует явного hostname и lowercase path, без scheme, userinfo, tag и whitespace. Digest строго sha256 + 64 hex. Labels доверенного builder проверяются после pull; identity/hash не являются подписью и не заменяют доверенный build/manifest канал.

После push получить digest из Registry API и сверить SHA256 manifest bytes и push result. Pull по digest должен дать ожидаемый config image ID и RepoDigests. Конвертация дополнительно требует совпадения исходного qualified local ID с pulled config ID либо registry manifest digest (Docker Desktop/containerd image store). Другой rebuild с теми же labels отвергается; multi-platform преобразование без такого совпадения fail closed и требует отдельной qualification. Только после этого преобразовать исходный проверенный local manifest:

```sh
node scripts/release-manifest.cjs distribute --manifest "$LOCAL_MANIFEST" --backend "$BACKEND_REGISTRY_DIGEST_REF" --frontend "$FRONTEND_REGISTRY_DIGEST_REF" --output "$REGISTRY_MANIFEST"
node scripts/release-manifest.cjs prepare --manifest "$REGISTRY_MANIFEST"
```

`prepare` загружает всю пару и проверяет digest/provenance до любой остановки активных services. При ошибке не продолжать rollout/rollback и не закрывать known-good pair. Затем выполняется прежний live schema preflight и guarded `override` с одним manifest. Registry override сбрасывает build и использует `pull_policy: always`; локальный режим сохраняет never. До maintenance/stop обязательно успешное prepare, schema/migration checks и quiet Compose validation. После перехода сверить container Config.Image с обеими digest refs, actual Image с config ID pulled artifact и RepoDigests с manifest. Отказ pull не даёт разрешения на остановку active pair. Запуск services последовательно допускает bounded outage, не обещает атомарность runtime/zero downtime.

Credential helper/DOCKER_CONFIG и login устанавливаются оператором вне repo; credential values не передавать в чат, CLI arguments или manifest. Root/operator Docker trust и network access входят в deployment boundary. Для production нужен отдельный квалифицированный TLS/auth registry target; локальный HTTP registry и пустой disposable daemon доказывают только механику на проверенной платформе.


После успешного prepare и schema/config preflight registry переход выполняется без повторного сетевого pull:

```sh
docker compose up -d --no-build --no-deps --pull never backend
# readiness200 и no pending migrations
docker compose up -d --no-build --no-deps --pull never frontend
```

`--pull never` здесь обязателен: он переопределяет default pull_policy:always только после свежего prepare всей пары. Иначе поздний отказ registry после maintenance/stop способен создать outage. При любой ошибке prepare active pair остаётся работать. Cache не подменяет первичную проверку: deploy refs остаются repository@digest, validated RepoDigests/provenance обязателен. Не удалять prepared images между prepare и переходом.
