# Phase 2B — независимая read-only проверка хоста

## Итоговая приёмка после Merge PR #19 — 3 ноября 2026

**ACCEPTED для read-only host verification.** Protected `test` указывает на
`40f11e290dfc6cf2285935a22d59feb25fa0121e`; post-merge push CI
[`41455785016`](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41455785016)
завершился SUCCESS и опубликовал `test-channel-1`. Каноническая identity
манифеста — `0859b3201abbd1563855efdb508a6e774148b96d13cb12cfe511779818a3898b`.
Проверка `shape` прошла; шесть SHA256 квалифицированных helpers совпали с байтами
доверенного checkout. Деревья `deploy` и `scripts` целевого TEST commit и checkout
совпали. Исходные файлы и миграции verifier читал из Git blobs целевого commit.

Изолированный GitHub-hosted Linux/amd64 run
[`41459710402`](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41459710402)
завершился SUCCESS. В runner временно подготовлены root-owned
`/home/hs/homecloud-test` и `/usr/local/sbin/homecloud-update-verify`, очищены
унаследованные ACL на доверенном пути и удалена добавляемая `actions/checkout`
настройка `gc.auto`, запрещённая root boundary. Эти операции не меняли trust
anchor или продуктовый Git config. Фактические ownership/mode: checkout и anchor
`root:root 0755`, inbox `root:65533 0770`, request `1001:65533 0600`.
Проверки root boundary, ACL, pinned helpers и request прошли; root-boundary suite
(18/18) и пять trust suites (57/57) завершились PASS. Shell проверял код выхода verifier
через `pipefail`. Непосредственный запуск установленного anchor через
`/usr/bin/python3 -I -S` с настоящими GitHub/GHCR завершился точным результатом:

```json
{"commit":"40f11e290dfc6cf2285935a22d59feb25fa0121e","installation_enabled":false,"manifestSha256":"0859b3201abbd1563855efdb508a6e774148b96d13cb12cfe511779818a3898b","provenance_signature":"UNSIGNED","status":"HOST_VERIFIED_READ_ONLY"}
```

Verifier проверил оба image index/platform/statement digest, provenance,
source_files и миграции, затем повторно получил GitHub evidence и проверил
локальное доверие/HEAD. Негативные случаи изменения HEAD, manifest, migrations,
ошибок сети и fail-closed покрыты trust suites. Повторный read-only вызов
verifier допустим; защита от повторной установки относится к будущему worker.
Предыдущие разделы ниже описывают состояние **до** Merge и сохранены как
исторический checkpoint. Root anchor был подготовлен только внутри runner;
mini-PC и production не менялись. Установка и auto-update остаются выключены.
Provenance остаётся UNSIGNED, поэтому это не криптографическая аттестация
всего содержимого образов.

Отдельная точка входа: `deploy/linux/update-host-verify.py`. Admission не изменён:
`VALIDATION_REQUIRED` остаётся терминальным статусом. Verifier не записывает receipt,
не удаляет request, не вызывает установщик, Docker, SSH, backup, rollback или systemd.
Вывод `HOST_VERIFIED_READ_ONLY` — результат проверки в данный момент, не разрешение установки.

## Граница доверия

Будущая установка anchor — отдельная ручная квалификация; в этой фазе ничего не
развёрнуто. Anchor должен находиться вне checkout по фиксированному пути
`/usr/local/sbin/homecloud-update-verify`, root-owned, без групповой записи/ACL.
Команда после отдельного provisioning: `/usr/bin/python3 -I -S /usr/local/sbin/homecloud-update-verify`.
Shebang `-IS` также требует isolated Python без site-packages.
Checkout фиксирован: `/home/hs/homecloud-test`; применяется существующий root boundary.

Anchor закрепляет SHA256 шести helpers и компилирует исключительно проверенные
байты. Checkout не добавляется в sys.path; untracked Python не используется для
поиска импортов. Обновление helpers требует независимого review, обновления pins
и отдельного provisioning anchor. Сам целевой коммит никогда не является источником
исполняемого Python. Деревья deploy/scripts целевого и доверенного коммитов должны
совпадать; целевые helpers дополнительно сверяются с pins. Новые модули в этих
деревьях также требуют квалификации.

Заявка читается один раз существующим admission reader (NOFOLLOW, ownership, mode,
length). GitHub token берётся только из окружения процесса; CLI не принимает его
аргументом и выдаёт фиксированное сообщение при любом отказе. API и artifact
используют существующий bounded client, artifact storage не получает Authorization.
GHCR redirects удаляют Authorization; token response теперь ограничен по размеру.

## Проверки

- Точная структура заявки и TEST manifest, canonical SHA256 и фиксированный repository.
- Protected TEST HEAD, успешный push CI workflow/run/attempt, точный artifact.
- source_files, полный список миграций, class names и SHA256 читаются из Git blobs
  целевого коммита через ls-tree/cat-file, без checkout/worktree/clone/fetch.
- Symlink/submodule вместо файла отклоняется; blob ограничен 16 MiB.
- Оба GHCR index digest, platform digest, statement digest и существующая
  BuildKit mode=max проверка. Новый source_reader в provenance.verify получает
  Dockerfile, images.lock.json и images.platforms.json из целевого коммита.
  Прежние вызовы provenance.verify сохраняют прежнее поведение.
- После GHCR повторно проверяются все GitHub evidence; затем root boundary,
  helper pins и неизменность локального HEAD. Любая ошибка означает отказ.

Отсутствующий локальный target object или сеть — STOP. Verifier не скачивает Git
objects и не пытается исправлять окружение. Будущий worker обязан повторять всю
проверку перед действием; результат этой фазы не устраняет последующие гонки.

## Независимый security review

Выявлены и исправлены:

1. P1: самосогласованный manifest мог разрешить изменённый target host helper.
   Добавлены tree gate, pin gate и негативные тесты. Это был обход qualification
   policy, не исполнение target-кода.
2. P2: shebang не включал обязательный -S. Исправлен на -IS.
3. P2: существующий GHCR token endpoint читался без лимита. Добавлены лимит,
   проверка типа/длины токена и тесты oversized/null/whitespace.

Ограничение: BuildKit provenance остаётся UNSIGNED. Проверка digest/subject/VCS/
Dockerfile/base materials не является криптографическим доказательством того,
что всё содержимое образа построено из заявленного исходного коммита. Доверие
опирается на protected TEST, GitHub CI/artifact и registry. Установка не разрешена.

## Проверка реализации — исторический снимок 28bd704

- Исходные Phase 2 evidence/source/admission: 16 + 9 + 5 = 30 PASS.
- Host verifier: 16 PASS; provenance: 11 PASS.
- Широкий прогон 41 Python test suite: после предоставления localhost доступа
  scheduled-operations и задания HOMECLOUD_TEST_ROOT для preflight все наборы
  прошли; recovery-storage имеет 3 skip, scheduled-operations — 1 skip.
- Frontend: 27 suites / 325 PASS. Backend Updates: 5 suites / 27 PASS.
- Полный backend unit-профиль запускался на macOS: есть падения Linux-only
  secure filesystem и HTTP upload-тестов; Jest оставил открытые handles и был
  завершён после результата. Это блокер полной зелёной регрессии, а не PASS.
- Backend/frontend lint: PASS (backend: 20 предупреждений); обе сборки PASS.
- Live GHCR/GitHub и Linux root provisioning не выполнялись. Нужны отдельная
  квалификация и Linux CI до PR/следующей фазы. Mini-PC не затронут.

## Финальная квалификация перед PR — 2 ноября 2026

Исходное состояние: ветка `мост-обновлений-этап-2`, HEAD `28bd704`.
`git ls-remote origin refs/heads/test` подтвердил `3c4c63584286740022945ebcb69fb27e2f689b37`,
совпадающий с локальным test. Проверены все три коммита Phase 2B и diff относительно
этого test. Шесть SHA256 в QUALIFIED соответствуют фактическим байтам helpers.
Admission, root-boundary, installer, Compose и systemd не менялись.

### Подтверждённое исправление

Независимый review обнаружил, что обязательный Fast/Integration workflow не
запускал новые trust-verification тесты. В `pr-fast-backend` добавлены admission,
evidence, source-http, host-verifier и provenance suites. Они входят в existing
terminal gate через успешность backend job. Тесты и qualification pins не ослаблены.

### Read-only live evidence

GitHub credential получен в память процесса, не записывался в файл, не передавался
аргументом и не экспортировался в GHCR окружение. GHCR читался анонимно. Проверено:

- protected TEST: `3c4c63584286740022945ebcb69fb27e2f689b37`;
- успешный push CI run `41314396371`, artifact `13086925946`;
- canonical manifest SHA256: `c83d511a64bf1e3e978eca251b16ff0f1c6752a0b31eec5df858d4249c0027ce`;
- source_files и полный набор 30 миграций из Git blobs этого TEST-коммита: PASS;
- backend index: `sha256:a615a47f55829604da878fc948d1451a81045419d0934fa0c908abe5094b7416`;
- frontend index: `sha256:1b89293a3d65492ef5ad2f8960f1d3790cd5ee3e1ba1321f12fb61b007aa1d50`;
- для обоих: digest, OCI labels/platform, statement subject/digest, BuildKit
  provenance с Dockerfile и обоими image lockfiles из TEST-коммита: PASS;
- полное повторное получение GitHub evidence после GHCR: PASS.

Это **диагностика компонентов, не полный live HOST_VERIFIED_READ_ONLY**.
Настоящий target qualification gate отклонил этот manifest: deploy/scripts в
старом TEST отличаются от квалифицированного checkout; старый TEST также не
содержит новых pinned helpers. Отдельный CLI запуск корректно выдал STOP: локальный
checkout не является установленным root-owned anchor на квалифицированном хосте.
Ни trust_check, ни target gate в рабочем verifier не заменялись на заглушки.
Для диагностики GHCR использован provenance.verify отдельно с target Git reader;
успех этой диагностики не засчитывается как проход host gate.

Полный live PASS до PR/merge не достижим при одновременно действующих требованиях:
не менять TEST, не разворачивать anchor, сохранить target-helper qualification
и проверять именно текущий protected TEST. Merge не выполнялся. Автоматическая
установка и UPDATE_INSTALL_BRIDGE_ENABLED остаются выключенными. UNSIGNED
provenance не считается криптографически подтверждённой аттестацией.

### Разбор Python skips

| Проверка | Причина прежнего skip | Итог |
| --- | --- | --- |
| scheduled-operations / test_existing_encrypted_backup_wiring | Нет age и age-keygen на macOS | В одноразовом Linux с настоящим age: 22/22 PASS, skips нет; используются только synthetic fixtures |
| recovery-storage / Baseline.test_bind_source_is_not_named_volume | Требует явного --baseline и старого baseline-root | Оставлен skip: историческое сравнение старого кода, не проверка текущей реализации |
| recovery-storage / Baseline.test_external_name_is_not_project_prefixed | То же | Оставлен skip; текущая семантика внешнего volume покрыта StorageFixtures |
| recovery-storage / Baseline.test_override_must_match_actual_backend | То же | Оставлен skip; текущая семантика override покрыта StorageFixtures |

Обычный recovery-storage запуск: 25 обнаруженных, 22 PASS, 3 исторических skip.
Режим --baseline также намеренно отключает текущие Storage/ReconciliationFixtures;
его запуск вместо обычного режима не является полной регрессией. Старый checkout
для сравнения не создавался. Остальные условные skip в unittest относятся к
отсутствию Node (restore-health) и POSIX/SIGKILL (test-test-channel). На нативном
Linux повторены restore-health (8/8) и test-test-channel (31/31): без skips. В backend test-routing любой skipped assertion или suite
является ошибкой, а не PASS.

### Полная backend-регрессия на Linux

Использован единственный существующий checkout, bind-mounted в `/workspace`;
worktree, clone и копия репозитория не создавались. `.git` дополнительно mounted
read-only. macOS node_modules и dist сохранены отдельными временными Docker volumes.
Тесты запускались от непривилегированного `node` (UID 501 для соответствия владельцу
bind-mounted checkout, вместо CI UID 1000). Тестовые файлы не менялись. БД —
одноразовый PostgreSQL с данными в tmpfs, без опубликованных портов и доступа
к данным mini-PC. Docker socket внутрь тестового backend не передавался.

Первый прогон использовал **точный amd64 pin CI**
`node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd`.
На ARM64 Docker Desktop его слой эмуляции возвращает ENOSYS для openat2:
4/61 unit и 4/31 integration suites упали на secure filesystem. Это не засчитано
как PASS и не исправлялось изменением тестов или защиты файловой системы.

Повтор проведён на **нативном Linux ARM64**, kernel `6.12.76-linuxkit`:

- Node `24.21.0`, npm `11.21.1` (скачан архив из install-npm.py, проверен закреплённый
  SHA256, установлен offline); Perl `5.36.0-7+deb12u4`; GCC и native addon собраны
  внутри Linux. GitHub-hosted context не имитировался поддельными env flags:
  использована функция install() с той же checksum-проверкой архива.
- Образ `node@sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc` —
  ARM64 platform того же закреплённого в images.platforms.json `node-ci` index
  `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
  Registry manifest inspection подтвердил: amd64 platform этого index — CI pin
  `51b1100…`, ARM64 platform — `ba6b7d0…`. Это одинаковая версия/дистрибутив,
  **не точное воспроизведение архитектуры amd64 GitHub runner**.
- PostgreSQL: CI index
  `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`,
  локально его нативная ARM64 platform, PostgreSQL `16.15`.
- Запущены обе полные маршрутизации существующего test-routing.py:
  **unit 61/61 suites, 942/942 tests PASS**;
  **integration 31/31 suites, 355/355 tests PASS**.
- Обе JSON reports прошли существующий `test-routing.py verify`: ни отсутствующих,
  ни лишних suites, ни skipped assertions. Итого **92 suites / 1297 tests PASS**.
- На нативном Linux также повторены пять подключённых trust suites:
  admission 5, evidence 16, source-http 9, host verifier 16, provenance 11 — **57 PASS**.

Точное amd64 выполнение без эмуляции остаётся задачей настоящего GitHub CI.
Нативный ARM64 PASS подтверждает backend на Linux, но не подменяет amd64 runner.


### Финальные проверки и решение по PR

Backend lint: PASS, 0 errors / 20 существующих warnings. TypeScript --noEmit и
build: PASS. Compiled file-type/runtime контракт: PASS. Patched dependency/runtime
проверки: 7/7 PASS, skips нет. YAML workflow разобран парсером; все пять trust suites
присутствуют ровно один раз в обязательном backend job. Frontend в этой квалификации
не менялся; его предыдущие результаты приведены только в историческом разделе.

Финальный независимый review diff относительно test и рабочего исправления CI:
новых actionable security findings нет. Единственный подтверждённый coverage gap
исправлен. Отдельный независимый targeted прогон: 57 PASS; шесть pins проверены.
Ревьюер отдельно подтвердил, что ожидаемый live STOP нельзя превращать в PASS
путём обхода qualification gate и что ARM64 результат не заменяет amd64 CI.

**Полная квалификация не завершена. Push и PR не выполнены**, поскольку обязательный
полный live HOST_VERIFIED_READ_ONLY отсутствует. Нового PR CI нет; live TEST run
41314396371 проверен как успешный. Merge и deployment не выполнялись.

Оставшиеся ограничения/блокеры:

1. Нужен согласованный порядок acceptance полного live host verifier: текущий TEST
   не содержит квалифицированных helpers этой фазы, а изменение TEST/merge запрещено.
   Этот порядок нельзя исправить изменением тестов или снятием tree/pin gates.
2. Root-owned anchor и host boundary не provisioned; реальный host CLI end-to-end
   не квалифицирован. Mini-PC и production запрещены для изменений в этой фазе.
3. На настоящем amd64 GitHub runner потребуется подтвердить CI целиком; локальный
   native ARM64 backend PASS не является доказательством amd64 эквивалентности.
4. UNSIGNED provenance сохраняет ограничение доверия, указанное выше.

Одноразовые контейнеры, PostgreSQL, network и dependency volumes после проверок
удаляются; исходные macOS зависимости сохраняются. Локальные подробные логи —
`docs/evidence/phase2b-*.log` (ignored, не входят в коммиты). Три посторонних
untracked-файла сохраняются; перед завершением сверяются их SHA256.
