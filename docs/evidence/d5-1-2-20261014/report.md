# D5.1.2 — Release Readiness, 2026-10-14

**BLOCKED. Production NO_GO. COMPLETE не установлен. D5.2 NOT_STARTED.**

Baseline local/remote PR HEAD79f8e4b72883b775d6fa2fac8f1209da26843f9f, ветка этап/d5-1-ci, draft PR1. Mainb5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4. Историческая D4 ancestry48fb9c0 сохранена. Проверенный implementation source9d33bd2a37a94989f61aafdf979bf30f4ca4621b; последующий evidence-only HEAD проверяется отдельно по live CI. Старые D5.1.1 runs не используются как доказательство новых изменений.

## Изменения и проверки

[Зависимости и все30исходных records](./dependencies.md): file-type21.3.2 direct/Nest закрывает ASF/ZIP; uuid9 удалён совместимыми NestTypeORM11.0.3/Terminus11.1.1, Nest10 сохраняется. Audit25moderate full/4production, high/critical0; frontend0advisories в свежем CI. Residual SSE/dev sprintf owner proposal и deadline13ноября, ACCEPTANCE_PENDING; exceptions в code/CI отсутствуют.

[Node, pins и реальные сканы](./images-node.md): Node24.21.0 LTS, nginx1.30.5, Postgres16, verified linux/amd64. Trivy0.75.0: Node8H, nginx3H, Postgres1C/24H, CI Node4C/60H. Все4valid JSON reports retained, gateBLOCKED, не PASS. Pinning и npm audit0high не квалифицируют OS/bundled tooling.

Локально Node24 targeted163/163, dependency helper7/7, compiled ESM/ASF/ZIP/Nest/UUID PASS; frontend278/278/lint/buildPASS. Backend full Mac956PASS/38FAIL/154SKIP: Linux descriptor filesystem fail-closed, PostgreSQL не задан; это ожидаемые platform limits, результат FAIL честно сохранён. Backend lint0errors/15existing warnings, buildPASS. Compose config4, startup43, preflight76, release16, provenance7PASS, actionlintPASS. [Local summary](./local-checks.json), logs/raw находятся рядом. Fresh Linux/PG CI обязателен.

[Независимый security/release review](./independent-review.md): IMPLEMENTATION APPROVE / RELEASE BLOCKED; unresolved MUST_FIX0. Reviewer дополнительно52health/sharing,7runtime,7provenance,16release PASS.

## GitHub rulesets

После явного ответа владельца «Применить три rulesets» применены exact JSON request payloads и перечитаны GitHub API. Main protected=true: обязательный gate GitHub Actions15368, strict base, PR/review1, last push approval, unresolved threads blocked, no bypass/force/delete. V* update/delete/force запрещены без bypass; creation-only отдельный ruleset имеет admin role5 bypass, не обходит immutable ruleset. [Before](./rulesets-before.json), [after](./rulesets-after.json), [effective main](./main-rules-after.json). Remote destructive tests не выполнялись.

Единственный collaborator sv3t0v1k admin; reviews[], reviewDecisionREVIEW_REQUIRED. Требуется отдельный человек с соответствующим GitHub доступом; независимый агентский security review не заменяет GitHub approval.

## Provenance dry-run

Verifier checks root index digest→amd64 config/labels→attestation/in-toto subject→VCS exact SHA/source→mode=max Dockerfile→pinned args/mapped base materials. Registry credential redirects защищены. Release candidate включает per-image proof и hashes новых verifier/scanner/mapping/pair scripts. Fresh exact published digests будущий workflow сканирует before draft; сейчас workflow не запускается.

Реальные CI offline archives, оба proof и manifest пары PASS на source9d33bd2. Synthetic tag object hash вычисляется только в памяти; реальные objects/refs/tags/release не создаются. GHCR NOT_PUBLISHED/NOT_TESTED. Unsigned local-context VCS — builder claim, не криптографическая гарантия source content. Отдельный dry-run format не подменяет release-lock/D1 manifest.

## Конкретные блокеры

1. Реальные high/critical image findings — адресная remediation и повторный полный scan, без blanket exceptions.
2. Residual Nest SSE/dev sprintf risk acceptance пока не утверждён; владелец/срок предложены, не выдумано одобрение.
3. Независимое GitHub approval требуется применённым main ruleset; reviewer с доступом пока отсутствует.
4. GHCR availability/reconciliation не проверены в рамках запрета publish и не заявляются PASS. Это ограничение dry-run; публикация/approved tag требуют отдельного разрешения после устранения остальных блокеров.

Mac runtime Compose/данные/другие Docker приложения не менялись, мини-ПК не опрашивался. Merge/tag/release/GHCR publish/deploy не выполнялись. Запрещённый audit-файл исключён до любого чтения diff/search/hash/stage; посторонние untracked сохранены.

## Первый фактический CI и адресные corrections

Source8a9add6: push38545262386/PR38545268447 — FAILURE. Configuration/frontend/security/secretsPASS. Backend checkout отказал по missing system CA в slim: apt добавляет ca-certificates, TLS verification не отключена. Nginx -t достиг valid syntax, затем runtime CHOWN probe отказал при capdropALL: только ephemeral check получает CHOWN, остальные ограничения сохраняются. Backend OCI действительно построен с attestation, но BuildKit material сообщает pinned parent index вместо resolved child: verifier теперь принимает только exact известный index или его exact verifiedamd64 child плюс platformlinuxamd64; произвольный materialSHA по-прежнему отвергается (8negative tests).

Реальные runtime image scans выполнены несмотря на другие failures: backend8HIGH/14MEDIUM/1LOW, frontend3HIGH/3MEDIUM. Base scans повторили локальные counts. Все gate failures сохранены; provenance pair первого запускаFAIL из-за отсутствующих frontend proof/failed backend verification, не PASS. Raw statuses/metadata/runtime scans рядом, next reviewed commit выполняет новый CI без отмены high/critical gates.

## Проверенный source9d33bd2 — фактический итог

[Push CI38545909829](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38545909829) и [PR CI38545917909](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38545917909) — **FAILURE**. Все failures теперь только runtime/base high/critical scans и общий gate; инфраструктурные/provenance errors устранены reviewed corrections. [Raw push](./github-ci-verified-push.json), [raw PR](./github-ci-verified-pr.json).

Backend **1148/1148**,79/79suites,0FAIL/SKIP,12PostgreSQL suites/154tests. Node24 compile, lint0errors/15existing warnings, build/compiledASFZIP/UUID/runtime7PASS. Frontend278/278, lint/buildPASS; configuration4Compose/43startup/76preflight, release16/provenance8, security/secretsPASS. Fresh audit backend25moderate/frontend0/highcritical0. [Сводка artifacts](./github-ci-test-summary.json).

Обе Linux/amd64 images собраны, backendmusl/native/Sharp и frontendnginx-tPASS. Фактические runtime scans: backend8HIGH/14MEDIUM/1LOW, frontend3HIGH/3MEDIUM. [Backend scan](./image-runtime-backend.json), [frontend scan](./image-runtime-frontend.json). Node8H/nginx3H/Postgres1C24H/CI Node4C60H base scans повторноFAIL. Ни scan, ни общий CI не объявленыPASS.

Оба verifier и provenance-pairPASS независимо от scan failure, без обхода общего gate. [Непубликуемый manifest](./provenance-dry-run-summary.json) содержит exactsource9d33bd2, оба index/platform/statementdigests, source hashes, bases и hypothetical annotated-object hash только в памяти. ManifestSHA256`0c77218b366a2ef95f074cd1df2b81edd2810b4c2b2a9a4bf1d69228216d7add`. Unsigned; реальные tag/GHCR/releaseNOT_RUN. [Backend proof](./offline-backend.json), [frontend proof](./offline-frontend.json), [итог независимого review](./independent-review.md).

Пять направлений D5.1.2 исследованы и проверены; итоговое решение **BLOCKED**, без ProductionGO/COMPLETE. Следующий необходимый scope — адресная image remediation и перескан, предметное решение по двум remainingGHSA, приглашение допустимого GitHubreviewer. Merge/release/D5.2 не запускаются автоматически.

Raw dry-run manifest сохранён без изменения в GitHub artifact11884496946 и workspace outputs/d5-release-readiness-20261014/provenance-dry-run.json. В Git committed отдельная явно обозначенная summary, не выдаваемая за raw manifest. Два поля source_files с migration token filenames и SHA256 source hashes срабатывают как generic-api-key false positives; hashes сверены с actual source, это не credentials. Raw manifest не изменён и не скрыт; secret allowlist/gate не менялись.
