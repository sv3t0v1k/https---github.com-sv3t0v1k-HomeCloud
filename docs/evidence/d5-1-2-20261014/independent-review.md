# D5.1.2 — независимое security/release review, 2026-10-14

Вердикт до публикации изменений: **IMPLEMENTATION APPROVE / RELEASE BLOCKED**.
Неустранённых обязательных замечаний к просмотренной реализации нет. Этот вердикт не означает
успешную квалификацию образов, GitHub CI, remote GHCR или готовность production. Production **NO_GO**;
COMPLETE не установлен. Исходный HEAD review: `79f8e4b72883b775d6fa2fac8f1209da26843f9f` плюс
просмотренный D5.1.2 diff; окончательный source commit и PR/push результаты фиксирует основной отчёт.

## Объём и независимость

Reviewer не автор изменения dependencies, Dockerfiles, CI, registry verifier или release policy.
Просмотрены фактические diff package/lock, compiled parser helper, Dockerfile defaults/image locks,
CI/release workflows, release manifest shape, OCI/GHCR verifier, synthetic pair builder, scanner/install
scripts, raw npm/Trivy evidence и применённые rulesets. ROADMAP и release-management использованы
как контекст границ D5.1/D5.2. Единственное исходное изменение reviewer — adversarial tests в
`scripts/ci/test-provenance.py`; production исходники не менялись.

Запрещённый audit исключён заранее из широких Git pathspec, его содержимое не читалось,
не искалось и не хешировалось. Docker daemon, работающий Compose/данные, mini-PC, теги, релизы,
registry publish, commit/push reviewer не использовал и не изменял. Live GitHub проверялся только read-only.

## Проверенная реализация

- Exact `file-type21.3.2` устраняет [ASF](https://github.com/advisories/GHSA-5v7r-6r5c-r473)
  и [ZIP](https://github.com/advisories/GHSA-j47w-4g3g-c36v) advisories; прежний nested20.4.1 удалён
  из lock через scoped Nest common override. Проверен действующий CommonJS→native ESM bridge,
  оба app source entrypoints и отдельный framework FileTypeValidator. Малый header/try-catch не
  объявлен защитой от event-loop hang. ASF55B regression исполняется в child с внешним10s deadline;
  ZIP control классифицируется docx, oversized compressed fixture<4100B с marker после1MiB — zip.
- TypeORM adapter11.0.3 явно допускает Nest10/core10/typeorm0.3 peers; nested uuid9 удалён без
  cross-major override uuid. Terminus11.1.1 допускает adapter11 и Nest10. Runtime framework10
  сохранён. UUID generation и health/sharing поведение проверены независимо под Node24.
- Node24.21.0 используется в CI, frontend/security tools и production builder/runtime. Dockerfiles
  и lock pinned по immutable digests; index→linux/amd64 child mapping хранится отдельно. Main/production
  Compose floating references пользователя не переписывались. musl/native/nginx smoke новых images
  должен реально выполниться в свежем GitHub CI; Node20 результаты его не заменяют.
- Scanner pinned release/checksum, включает OS/language findings всех severities, unfixed included,
  без ignore policy. Валидность scan/platform/os-results проверяется, high/critical приводят к failure;
  raw reports сохраняются. Сканируются четыре bases и реальные application images. Release workflow
  дополнительно проверяет exact уже опубликованные digests до draft; оба reports сохраняются при
  failure. Workflow не запускался в review, его внешние публикации остаются отдельным разрешением.
- OCI verification проверяет hash/size index/manifest/config/statement, единственный linux/amd64,
  OCI source/revision/version/role/pair, attestation subject и BuildKit v0.2 predicate, exact clean VCS,
  mode=max Dockerfile bytes/build definition, pinned build args и exact resolved base material digests.
  Поддерживаются legacy annotations и OCI artifact subject. Registry redirects не пересылают
  Authorization; non-HTTPS redirect отвергается. Это unsigned builder claims, не криптографическая
  аутентификация всего source content. Synthetic manifest не создаёт Git object/ref/tag, не публикует
  GHCR и не выдаётся за release candidate/deployment evidence. GHCR availability/readback **NOT_TESTED**.
- Новый `provenance-pair` выполняется даже после image-scan failure, но missing/incomplete proof
  блокирует pair; общий gate всё равно требует success всех security/image jobs. `always()` не
  делает security failure успешным. Auto Buildx dirty inspection отключена; tracked source cleanliness
  проверяется явным Git pathspec с запретным путём, untracked build source отвергается.

## Независимые проверки

| Проверка reviewer | Результат |
| --- | --- |
| Compiled file-type helper на Node24.21.0, окончательный strengthened ZIP fixture | PASS |
| Health + sharing Jest,2suites |52/52 PASS |
| Existing compiled dependency-security runtime |7/7 PASS |
| Release/tag/manifest/audit negative fixtures |16/16 PASS |
| Provenance/pair adversarial fixtures |7/7 PASS |
| Shell syntax install/scan, scoped diff whitespace |PASS |
| All30 исходных npm audit records имеют пакет/path/reachability/решение/deadline/owner |PASS |
| Raw npm audits |25moderate full /4moderate production, high/critical0 |
| Четыре actual remote base scans |BLOCKED, counts ниже |
| Read-only GitHub rulesets/main API |3active rulesets, mainprotected=true |
| Actual application image OCI/scan и свежий PR/push GitHub CI |PENDING на момент review |

Первый independent sandbox Jest run имел8FAIL/44PASS из-за `listen EPERM`; повтор с разрешёнными
временными локальными HTTP listeners дал52/52PASS. Это не product failure и не скрытая пропущенная
проверка. Просмотренный полный Mac backend snapshot имеет956PASS/38FAIL/154SKIP: его нельзя
объявлять PASS. Linux/PostgreSQL acceptance оценивается по свежему фактическому CI.

Adversarial fixtures проверяют index/blob substitution, regenerated-checksum bad labels/role/pair,
platform, dirty/mismatched VCS, changed Dockerfile, missing max definition/materials, wrong resolved
base digest, wrong in-toto subject/type, credential stripping, missing/mismatched proof fields, dirty
checkout и source drift pair. Fixtures не обращаются к Docker/registry и не создают project refs.

## Замечания и исправления в ходе review

1. Offline CI pair label первоначально имел лишний `:dry-run`, verifier требовал exact commit.
   Label согласован с verifier; mismatched pair covered negative fixture.
2. Первоначальная base material проверка принимала произвольный корректный SHA256. Добавлена
   exact index→amd64 mapping и сравнение material digest; refreshed-checksum mutation отвергается.
3. Security verifier/scanner/platform mapping/pair hashes добавлены в release source contract;
   per-image provenance proof обязателен в manifest shape.
4. Registry redirect пересылал Authorization через стандартный urllib handler; теперь credentials
   удаляются, insecure redirect blocked; независимый fixture PASS.
5. Pair зависел от image job со scan и мог быть skipped при ожидаемом HIGH/CRITICAL. Pair теперь
   выполняется независимо от результата scan с fail-closed artifact validation; security gate сохранён.
6. Первоначальный ZIP fixture подтверждал только generic ZIP outcome. Добавлены small docx control
   и office marker за inflate cap; окончательный helper независимо повторён PASS.

## Реальные оставшиеся препятствия

Четыре raw Trivy reports независимо пересчитаны, metadata linux/amd64 и RepoDigests просмотрены:

| Base | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node24 Alpine |0|8|13|1|0|
| nginx1.30.5 Alpine |0|3|3|0|0|
| PostgreSQL16 Alpine |1|24|28|3|5|
| Node24 bookworm-slim CI |4|60|113|84|1|

Это scanner package findings, не доказанные app exploit paths; они всё равно блокируют принятую
политику image qualification. Reviewer не одобряет blanket exceptions, отключение gate или
объявление этих images чистыми. [Raw результаты и причины](./images-node.md).

Остаточные npm25/4 records сводятся к двум GHSA: Nest SSE и dev-only sprintf. Application SSE sink
не обнаружен в просмотренном backend source; dev YAML API не требует formatter CLI chain.
Эти bounded reachability conclusions не являются исправлением и не доказывают все будущие consumers.
Предложенные исключения имеют deadline2026-11-13 и proposed maintainer owner, acceptance **PENDING**,
в audit/CI exceptions не добавлены. [Реестр и решения](./dependencies.md).

Независимый read-only GitHub API подтвердил active rulesets25067633(main),25067634(immutablev*),
25067636(admin-only creation); mainprotected=true на `b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4`.
Просмотренные applied payloads требуют Actions15368 `gate`, strict branch status,1review и last-push
approval, запрещают main force/delete и tag update/delete без bypass; отдельный creation bypass
не распространяется на immutable ruleset. Требуется реальный допустимый GitHub reviewer:
agent review не заменяет GitHub approval и владелец не может сам approve свой PR.

На момент этого review настоящий OCI dry-run, final PR/push CI и GHCR remote readback ещё не
подтверждены. Присвоить READY нельзя. Дальнейшая проверка после safe push дополняет основной отчёт;
merge/tag/release/GHCR publish/deployment/mini-PC остаются запрещены в этой задаче.

## Повторное review после первого GitHub CI

Просмотрен diff исправлений поверх source `8a9add6fab55298c3397ea01b65e4f2d7512b92c`.
Первый [push run38545262386](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38545262386)
и [PR run38545268447](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38545268447)
обнаружили ошибки реализации CI помимо ожидаемых image vulnerability failures. Они не объявлены PASS.

- Реальная backend build metadata содержит pinned **parent index** `ebfe2f90…`, URI
  `pkg:docker/node@24.21.0-alpine?...&platform=linux%2Famd64`. Прежний verifier требовал только
  child digest и отвергал валидный BuildKit output. Новая проверка принимает ровно два заранее
  известных digest одного base — pinned index либо его проверенный linux/amd64 child — и дополнительно
  требует единственный URI platformlinux/amd64. Произвольные SHA, arm64, missing/ambiguous platform
  продолжают отвергаться. Это согласование фактического формата, не blanket exception.
- Raw checkout incident подтверждает TLS error `CAfile: none`. В isolated Node slim runner явно
  устанавливаются `ca-certificates`; TLS verification остаётся включена.
- Raw nginx incident подтверждает successful syntax parse и последующий отказ
  `chown(/var/cache/nginx/client_temp,101)` с EPERM. Только disposable `nginx -t` fixture получает
  capabilityCHOWN поверх dropALL; networknone/no mounts/no-new-privileges сохранены. Production
  Compose/service security не меняется.

Независимо повторены provenance **8/8** и release **16/16** PASS, scoped whitespace PASS. Добавлены
negative fixtures wrong/missing/duplicate material platform. Raw incident logs сохранены,
новый реальный CI ещё требуется. Вердикт исправлений: **APPROVE / RELEASE BLOCKED**;
MUST_FIX0 для просмотренного diff, image high/critical policy не ослаблена.
