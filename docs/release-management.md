# D5.1 — управление версиями и CI

Статус: D5.1.2 Release Readiness BLOCKED по реальным image high/critical и непринятым residual risks; PR/push CI source9d33bd2 FAILURE только image scans/gate, тесты и OCI dry-run PASS. Production NO_GO. [Evidence D5.1.2](./evidence/d5-1-2-20261014/report.md).
Единственный roadmap — [ROADMAP.md](./ROADMAP.md). [Фактический аудит и проверки](./evidence/d5-1-20261013/report.md).

## Версии и границы

GitHub хранит интегрированный код, теги и результаты CI. Mac может опережать main; сервер может
работать на предыдущем проверенном source export. Различия должны быть видны, а не автоматически
перезаписываться. История D4 сохранена: b5c954f → e655167 → 48fb9c0; текущий Mac не переключается.

Единый следующий формат — `v0.MINOR.PATCH-beta.N`, без ведущих нулей, N ≥ 1. Minor — согласованный
этап/изменение контракта, patch — исправление, N — новый кандидат. Версия не означает процент
готовности. Пакетные 1.0.0/0.0.0 не являются release version. Существующий `v0.9.0-local.1` сохраняется.
Пример следующего кандидата `v0.9.1-beta.1` **не утверждён и не создан**. Git-тег — annotated,
аннотация, commit message, release title/body — по-русски. Новый кандидат требует нового тега;
force push, переназначение тега и перезапись release запрещены.

Успешный этап становится кандидатом только после acceptance, независимого review и CI gates.
Наличие тега, draft или опубликованных images само по себе не даёт COMPLETE/DEPLOYED/Production GO.

## CI и security policy

PR/push запускают `ci.yml`: backend native compile + полный Jest на отдельной PostgreSQL service,
frontend tests, lint обоих пакетов, build и compiled file-type check, четыре Compose config merges,
76 preflight/config + 43 startup fixtures, negative release tests, npm audit и gitleaks.
Сервис PostgreSQL существует только на GitHub runner; real DB credentials/target не используются.
PostgreSQL suites нельзя silently skip: job требует ≥12 соответствующих suites, все assertions PASS.
Другие skips видны в Jest JSON и требуют объяснения при acceptance.

Configuration job pins Compose5.1.3 binary с verified SHA256. Строгий preflight требует explicit false
в normalized JSON; Compose2.38.2 omitempty вывод не квалифицирован и fail-closed отказывается.
Pin/shim применяется только на ephemeral runner, не меняет Mac/server Docker.

Все Actions pinned полным SHA. PR/push имеют только contents:read; credentials checkout не сохраняются.
Нет pull_request_target, SSH, self-hosted runner или автоматического CD. `gate` отвергает любой failed,
cancelled или skipped обязательный job. Actionlint — локальная проверка синтаксиса/выражений workflows;
фактический GitHub runner проверяется после разрешённой публикации ветки.

`npm audit` проверяет полный backend и frontend tree. Невалидный ответ/ошибка registry — BLOCKED;
high или critical — BLOCKED. Moderate/low сохраняются в отчёте, требуют triage, не скрываются.
Нет baseline по числу advisories, continue-on-error, автоматического npm audit fix или dependency upgrades.
Исходный аудит13октября: backend production17, full55, frontend12. D5.1.1 на14октября:
backend production9moderate, full30moderate; frontend0; high/critical0 без ослабления policy.
[Реестр устранённых и открытых findings](./evidence/d5-1-1-20261014/report.md). ASF parsing untrusted
upload headers остаётся открытым release risk; green audit threshold не даёт Production GO.
Для исключения нужна отдельная согласованная remediation/документированная risk decision и review
изменения policy; текущий код исключений для high/critical не имеет.

Gitleaks v8.30.1 проверяет всю достижимую history. Запрещённый audit исключён Git pathspec **до чтения patch**.
48 historical findings независимо классифицированы: 36 SHA256 false positives, 12 synthetic fixtures.
`.gitleaksignore` содержит только 38 exact fingerprints для 48 findings commit:path:rule:line, без values и broad path/rule
allowlists. Новые commit/line findings не исключаются; изменения этого файла требуют security review.
Scanner не доказывает абсолютное отсутствие секретов. Результат нового diff дополнительно проверяется
перед публикацией. Нельзя публично прикладывать неотредактированный secret scan report.

Node20 сохранён ради scope/совместимости, но уже [EOL по данным Node.js](https://nodejs.org/en/about/eol); переход на поддерживаемую версию требует отдельной
задачи и регрессии. Pinning не устраняет CVE. OS/base image vulnerability scan и upgrades ещё не
квалифицированы; production gate остаётся закрыт. Native tests в glibc CI не заменяют musl image smoke
и испытания mini-PC. PR CI D5.1.1 добавляет ephemeral Linux/amd64 image builds
без publish и native decoder smoke без mounts/startup; это не target qualification.

## Релиз по явно утверждённому tag + commit

`release.yml` запускается **только вручную на main**. Inputs — tag и полный SHA текущей main.
Workflow требует protected main, annotated tag → exact HEAD, сохранённую D4 ancestry и отсутствие
existing release (включая draft). Затем заново выполняет reusable CI для этого SHA. Согласованные владельцем rulesets применены14октября: main protected=true; обязательный GitHub Actions gate15368, strict latest-base, один независимый review последнего push, разрешение review threads, без bypass/force/delete. Релизные v* запрещено менять/удалять без bypass; отдельный creation-only ruleset разрешает создание администратору. Фактические ответы API сохранены в D5.1.2 evidence. Единственный collaborator сейчас владелец: требуется отдельный reviewer с доступом; агентский review не является GitHub approval.
Необходимо включить обязательный `gate`, review и запрет force push/deletion; исключения/bypass требуют
отдельного owner decision. Workflow проверяет protection flag, но не доказывает состав GitHub rules.

После gates отдельный job (contents:read, packages:write) собирает Linux/amd64 backend/frontend
с pinned node/nginx base digests из `scripts/ci/images.lock.json`, OCI source/revision/version/role/pair
и BuildKit provenance mode=max. Секретов в build args нет. Образы получают уникальный tag
`<release-tag>-<run-id>-<attempt>`; не используется latest. Реальные references фиксируются digest.
Stock nginx ingress/postgres не пересобираются; lock содержит upstream digests для будущего D5.2.
Это **не меняет** floating refs работающего Mac/server Compose. Apt/apk/npm registry и runner VM не
заявлены как полностью воспроизводимая/offline цепочка. BuildKit provenance приложен к index,
криптографическая подпись/verification SLSA не заявляется. [Контракт Docker provenance](https://docs.docker.com/build/metadata/attestations/slsa-provenance/).

Перед release-lock job pull на disposable GitHub runner проверяет RepoDigest, linux/amd64 и exact OCI
labels обоих образов. Локальный Mac reconciliation pull не делает. Частичная ошибка publish может
оставить один unreferenced образ; draft тогда не создаётся. При retry новые run/attempt tags;
частичные artifacts не считаются release и автоматически не удаляются.

Отдельный job с contents:write повторно сверяет remote tag object и создаёт **draft prerelease** с
`release-lock.json`. Публичное опубликование draft выполняет владелец после review manifest/CI.
Workflow не создаёт tag и не перезаписывает release. Main фиксируется в validate; повторные сверки tag_object блокируют обнаруженную смену tag.
API check и publication не атомарны; protection release tags с запретом force/delete и owner control обязательны.

Кандидат `homecloud-ci-candidate-v1` хранит commit/tag/stage, run URL+attempt, оба digests, source hashes
Compose/Dockerfiles/lockfiles/migrations и список migration classes. Checksum обнаруживает изменения
файла, но не является подписью. Это отдельный формат: существующие D1 `homecloud-release-v1`,
recovery/rollback gates и qualification manifests **не подменяются** новым CI кандидатом.

После разрешения публикации и successful gates команды владельца (SHA/tag выбираются явно):

```sh
# В integration checkout на согласованной protected main; не переключать рабочий Mac автоматически.
REPO=sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud
RELEASE_TAG=v0.9.1-beta.1   # пример; сначала отдельно утвердить
SOURCE_COMMIT=$(git rev-parse HEAD)
git tag -a "$RELEASE_TAG" "$SOURCE_COMMIT" -m 'Кандидат этапа D5.1: проверки CI и привязка образов'
python3 scripts/ci/release.py verify-tag --tag "$RELEASE_TAG" --commit "$SOURCE_COMMIT"
# Следующие команды являются внешней публикацией: только после подтверждения владельца.
git push origin "refs/tags/$RELEASE_TAG"
gh workflow run release.yml --repo "$REPO" --ref main -f tag="$RELEASE_TAG" -f commit="$SOURCE_COMMIT"
gh run list --repo "$REPO" --workflow release.yml --limit 5
# Скачать candidate для review; это чтение GitHub, не deployment.
gh release download "$RELEASE_TAG" --repo "$REPO" --pattern release-lock.json --dir /private/tmp/homecloud-release-review
```

Сейчас эти команды release выполнять нельзя: реальные image scans содержат high/critical, остаточные npm риски не приняты и GitHub review required. Отдельное разрешение на tag/release/publish не дано.
После push PR CI не публикует GHCR; вручную release workflow запускается отдельным действием.

## Reconciliation и deployment evidence

Без подключения к mini-PC:

```sh
python3 scripts/ci/release.py reconcile \
  --mac-root /Users/aleksejkozemakin/Desktop/HomeCloud \
  --github-sha b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4 \
  --deployment docs/evidence/d5-1-20261013/deployment-reported.json
# Позже добавить --manifest /path/to/release-lock.json.
```

Exit2 означает drift/UNKNOWN, exit1 — невалидное evidence, exit0 — соответствие **предоставленных
снимков**, не live health. Mac branch/HEAD/dirty читаются locally из --mac-root (по умолчанию checkout скрипта); GitHub SHA — snapshot, сверяется
отдельно `git ls-remote origin refs/heads/main`. Скрипт не fetch/push/pull/SSH и не изменяет состояние.
Deployment JSON должен содержать `source_revision`, `observed_at`, `evidence`, `images` (role → repository@digest)
и `applied_migrations` (точные class names). Missing/different digests/schema сообщаются явно. Датированный
reported D4 snapshot содержит только известный source revision; digests/full schema unknown. Это не
текущая независимая проверка сервера. Config hashes/health/backup/mount identity не квалифицированы
offline; их проверка и доверенная подпись/custody evidence относятся к D5.2/production gates.

D5.2 начинается только отдельным разрешением: target preflight, backup/restore, approved digests,
immutable deployment record, health/smoke и rollback с проверкой schema compatibility. Нет обновления
mini-PC, общей Docker/DNS/mount/volume конфигурации в D5.1.

## D5.1.2 — проверенная подготовка, 2026-10-14

Node20 заменён Node24.21.0 LTS в CI/build/runtime; nginx1.30.5 и все bases pinned,
index→amd64 mapping хранится в images.platforms.json. pin не означает безопасный образ:
реальные Trivy0.75.0 scans Node/nginx/Postgres/CI Node содержат high/critical и блокируют gate.
Новые обязательные jobs сканируют bases и фактически собранную пару images; нет ignore-unfixed,
blanket exceptions или continue-on-error. Registry errors также fail-closed. Fresh published digests
будущий release workflow сканирует перед draft; этот workflow сейчас не запускается.

File-type direct/Nest copies21.3.2 закрывают ASF/ZIP. NestTypeORM11.0.3 + Terminus11.1.1
явно поддерживают Nest10; vulnerable uuid9 удалён без framework migration. Audit25moderate full,
4production; SSE и dev sprintf-js остаются в audit. Triage каждой из30исходных records
имеет proposed maintainer owner, срок2026-11-13 и ACCEPTANCE_PENDING. Исключений в gate нет.

Provenance verifier читает OCI metadata по digest и проверяет amd64 config/labels, attestation
subject, VCS source/revision, mode=max Dockerfile, pinned build args и exact mapped base materials.
При будущей публикации тот же verifier читает GHCR metadata fail-closed до создания candidate.
Registry redirects не пересылают Authorization; source contract включает verifier/scanner/mapping.
Unsigned builder claims не считаются криптографической аутентификацией source content.

PR/push dry-run строит локальные OCI archives с attestation mode=max/v0.2, не публикует их.
Общая пара создаёт отдельный homecloud-release-dry-run-v1: synthetic annotated object hash
вычисляется в памяти, Git object/ref/tag не создаётся. Intended GHCR repository + offline digest
не означает, что объект доступен в registry. GHCR reconciliation, реальный tag/release:
NOT_PUBLISHED / NOT_TESTED / NOT_CREATED. Dry-run не подменяет release-lock или D1 manifest.

[Итог и конкретные блокеры](./evidence/d5-1-2-20261014/report.md). Production NO_GO,
D5.2 NOT_STARTED, COMPLETE не установлен.
