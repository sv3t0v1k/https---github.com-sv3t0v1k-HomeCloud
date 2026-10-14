# D5.1.2 — Release Readiness, 2026-10-14

**BLOCKED. Production NO_GO. COMPLETE не установлен. D5.2 NOT_STARTED.**

Baseline local/remote PR HEAD79f8e4b72883b775d6fa2fac8f1209da26843f9f, ветка этап/d5-1-ci, draft PR1. Mainb5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4. Историческая D4 ancestry48fb9c0 сохранена. Финальный source SHA и свежий GitHub CI будут дописаны после safe push; старые D5.1.1 runs не доказательство новых изменений.

## Изменения и проверки

[Зависимости и все30исходных records](./dependencies.md): file-type21.3.2 direct/Nest закрывает ASF/ZIP; uuid9 удалён совместимыми NestTypeORM11.0.3/Terminus11.1.1, Nest10 сохраняется. Audit25moderate full/4production, high/critical0; frontend ожидает свежий audit CI. Residual SSE/dev sprintf owner proposal и deadline13ноября, ACCEPTANCE_PENDING; exceptions в code/CI отсутствуют.

[Node, pins и реальные сканы](./images-node.md): Node24.21.0 LTS, nginx1.30.5, Postgres16, verified linux/amd64. Trivy0.75.0: Node8H, nginx3H, Postgres1C/24H, CI Node4C/60H. Все4valid JSON reports retained, gateBLOCKED, не PASS. Pinning и npm audit0high не квалифицируют OS/bundled tooling.

Локально Node24 targeted163/163, dependency helper7/7, compiled ESM/ASF/ZIP/Nest/UUID PASS; frontend278/278/lint/buildPASS. Backend full Mac956PASS/38FAIL/154SKIP: Linux descriptor filesystem fail-closed, PostgreSQL не задан; это ожидаемые platform limits, результат FAIL честно сохранён. Backend lint0errors/15existing warnings, buildPASS. Compose config4, startup43, preflight76, release16, provenance7PASS, actionlintPASS. [Local summary](./local-checks.json), logs/raw находятся рядом. Fresh Linux/PG CI обязателен.

[Независимый security/release review](./independent-review.md): IMPLEMENTATION APPROVE / RELEASE BLOCKED; unresolved MUST_FIX0. Reviewer дополнительно52health/sharing,7runtime,7provenance,16release PASS.

## GitHub rulesets

После явного ответа владельца «Применить три rulesets» применены exact JSON request payloads и перечитаны GitHub API. Main protected=true: обязательный gate GitHub Actions15368, strict base, PR/review1, last push approval, unresolved threads blocked, no bypass/force/delete. V* update/delete/force запрещены без bypass; creation-only отдельный ruleset имеет admin role5 bypass, не обходит immutable ruleset. [Before](./rulesets-before.json), [after](./rulesets-after.json), [effective main](./main-rules-after.json). Remote destructive tests не выполнялись.

Единственный collaborator sv3t0v1k admin; reviews[], reviewDecisionREVIEW_REQUIRED. Требуется отдельный человек с соответствующим GitHub доступом; независимый агентский security review не заменяет GitHub approval.

## Provenance dry-run

Verifier checks root index digest→amd64 config/labels→attestation/in-toto subject→VCS exact SHA/source→mode=max Dockerfile→pinned args/mapped base materials. Registry credential redirects защищены. Release candidate включает per-image proof и hashes новых verifier/scanner/mapping/pair scripts. Fresh exact published digests будущий workflow сканирует before draft; сейчас workflow не запускается.

CI offline archives/proof/pair manifest pending actual run. Synthetic tag object hash вычисляется только в памяти; реальные objects/refs/tags/release не создаются. GHCR NOT_PUBLISHED/NOT_TESTED. Unsigned local-context VCS — builder claim, не криптографическая гарантия source content. Отдельный dry-run format не подменяет release-lock/D1 manifest.

## Конкретные блокеры

1. Реальные high/critical image findings — адресная remediation и повторный полный scan, без blanket exceptions.
2. Residual Nest SSE/dev sprintf risk acceptance пока не утверждён; владелец/срок предложены, не выдумано одобрение.
3. Независимое GitHub approval требуется применённым main ruleset; reviewer с доступом пока отсутствует.
4. Новый полный CI/реальная OCI dry-run chain pending safe push; фактический итог будет ниже. GHCR availability/reconciliation не проверены в рамках запрета publish и не заявляются PASS.

Mac runtime Compose/данные/другие Docker приложения не менялись, мини-ПК не опрашивался. Merge/tag/release/GHCR publish/deploy не выполнялись. Запрещённый audit-файл исключён до любого чтения diff/search/hash/stage; посторонние untracked сохранены.
