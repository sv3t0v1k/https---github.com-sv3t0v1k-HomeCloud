# D5.1.7 — квалификация рисков и решение о первом релизе

Дата: 2026-10-16 (Asia/Vladivostok). Исходный HEAD `36f2d2c`; PR №1 draft. **BLOCKED / Production NO_GO**. Никаких CVE dispositions не принято, security gates не изменены. Это реестр для решения владельца, не новый roadmap.

## Подтверждённые изменения

| Компонент | Было | Новый exact candidate / проверка |
|---|---|---|
| Production ingress | nginx1.28.3, 2C/60H | nginx1.30.6, amd64 `sha256:959ae6b898852db82e5b29b929388e59914f42be0a8f4d44c89a4c1f53b49208`; remote scan **0C/0H/1M** |
| Trivy Linux | 0.75.0, 4H | 0.76.0, binary SHA256 `1f889576636db0623539cb339df7d06c40ebf39e7919489eafa1160e29808f19`; **0C/0H**, UNKNOWN сохранены |
| Compose Linux | 5.1.3, 49H | 5.6.0, binary SHA256 `40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a`; **4H** |

Pinned URL/archive checksum и строгая проверка версии Trivy обновлены согласованно: старый0.75 отвергается. Остальные freshness/inventory/platform/severity проверки неизменны. В существующий ingress CI job добавлен `nginx -t` с production template, host validator, upgrade map и одноразовым self-signed cert. Только disposable GitHub runner; публикации/target access нет.

Targeted scans выполнены native Darwin Trivy0.76 в отдельном temporary cache: только два Linux ELF binaries и новый remote image. Mac rootfs/Docker не сканировались. DB UpdatedAt2026-10-15T13:13:18Z, NextUpdate2026-10-16T13:13:18Z; checked within24h. Registry index→amd64 manifest→config SHA256 совпадают, image OS/architecture и RepoDigests проверены. Эти проверки **не заменяют** source/run-bound OCI и фактическую Linux CI execution qualification.

Целевые проверки: **43 PASS** (scan-evidence10, environment23, coverage10), Compose5.6 normalizes четыре overlays PASS, shell syntax PASS. Полные app tests/build локально не повторялись: application code/dependencies не изменялись. Новый scanner меняет все квалификации, поэтому единственный итоговый CI необходим для проверки его совместимости; прежние101 PASS не выдаются за проверку нового HEAD.

## Компактный реестр

Подробный machine-readable реестр: `outputs/d5-1-7-20261016/risk-registry.json` в локальном mirror проекта. Он ссылается на immutable SHA256 исходного D5.1.6 index, покрывает **1722/1722 обязательных advisory/package/version/fixed tuples, 675 advisory IDs** и сохраняет связь с exact targets. Девять diagnostic-only tuples не смешиваются с обязательными. Buckets пересекаются по advisory; их числа нельзя суммировать как уникальные CVE. Все member dispositions **OPEN_NO_EXCEPTION**; отсутствие finding после замены артефакта подтверждается новым evidence, а не исключением.

Владелец каждой группы — **владелец проекта**, исполнитель DevOps/security ещё должен быть назначен. Указанные сроки — **предложенные даты review**, не согласованные обязательства; все release-blocking решения нужны до первого релиза. Evidence source: [CI D5.1.6](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38716019068), его retained artifact names ниже. Exact version/CVE lists — в реестре; здесь технически связанные группы.

| Группа / evidence artifact | Installed → fixed из scan | Применимость и рекомендация | Review до |
|---|---|---|---|
| P-POSTGRES / `support-image-postgres-1` | gosu1.19, Go1.24.6 → Go1.26.9 или1.27.2 для всей группы; critical CVE-2025-68121 →1.24.13/1.25.7 | **1C/24H только gosu**, не PostgreSQL server/OS findings. gosu реально запускается при privilege drop; TLS source imports отсутствуют. Текущий postgres16.15 tag — прежний amd64 `1a66d744…`, поэтому смена tag ничего не исправляет. Сохранённые exact ELF proofs:25/25 advisory,0 symbol matches; [per-CVE таблица](./d5-1-5-20261014/pg-per-cve-binary-evidence.json). Это evidence для индивидуальных решений, не полный runtime call graph и не исключение | 17.10 |
| P-INGRESS / `support-image-ingress-1` | 15 пакетов,62 records: OpenSSL3.5.5→3.5.8; nginx1.28.3-r1→r6; pcre2 10.47→10.49; musl1.2.5-r21→r23; curl/libcurl8.17→8.22; expat2.7.5→2.8.5; libuuid2.41.2-r0→2.41.6-r1; прочие в реестре | Public TLS/HTTP/regex имеют runtime-роль; не все библиотечные CVE достижимы. Новый digest устраняет H/C в candidate scan. Старый critical CVE-2026-31789 upstream32-bit-only, наш artifact amd64 — evidence для отдельного решения, не suppression | 17.10 |
| B-NPM / `stage-scans-{backend,frontend}-1` | brace-expansion5.0.7→5.0.11; tar7.5.19→7.5.21; ip-address10.2→10.3.1; undici6.27→6.28.1; http-cache-semantics4.2.0→нет fixed в evidence | **8H в каждой стадии**, global npm bundle, не runtime. npm обрабатывает недоверенные архивы/метаданные. Адресное обновление tool bundle, unfixed отдельно проверить upstream; не переписывать npm вручную без поддержки | 19.10 |
| B-ESBUILD / `stage-scans-frontend-1`; CI-APP-ESBUILD / `environment-{frontend,security-frontend}-1` | Go1.23.12→1.26.9/1.27.2 | Один frontend compiler,25 Go advisory (1C/24H), несколько файлов/исполнений. Разбирает input; gosu proof не переносится. Обновление esbuild/build toolchain либо собственный binary proof; frontend runtime0C/0H по D5.1.6 | 19.10 |
| B-BUILDKIT / `support-image-buildkit-1` | Go1.26.8 и CNI Go1.25.7→1.26.9/1.27.2; x/net0.43/0.58→0.60; go-archive0.2→0.3; pcre2 10.48→10.49 | **107H**, exact amd64 `98cc6a3f…`. Daemon/runc/CNI могут влиять на image output. Нужен fix всего image, не только buildkitd | 19.10 |
| CI-GITLEAKS / `environment-secrets-1/tools.json` |8.30.1, Go1.24.11→1.26.9/1.27.2; x/crypto0.35→0.55; x/text0.22→0.39 | **1C/35H**, последний официальный release тот же. История Git — недоверенный input; TLS/SSH applicability не доказана. Верифицированный rebuild либо per-advisory binary proof. Secret findings122/122 PASS в D5.1.6 не устраняет CVE инструмента | 19.10 |
| CI-COMPOSE / `environment-configuration-1/tools.json` | Candidate5.6: Go1.26.8→1.26.9/1.27.2; x/net0.58→0.60 | Остались **CVE-2026-78667/78669/97031**,4H records. В job только config/version без daemon; это ограничивает путь атаки, но не доказывает недостижимость. Патч upstream/rebuild или индивидуальная оценка | 19.10 |
| CI-TRIVY / все `environment-*/tools.json` | Candidate0.76 Go1.27.2, x/net0.60 | Candidate0H/C; **UNKNOWN GO-2026-5932, x/crypto0.57 без fixed** сохранён для review. Сканирует недоверенные artifacts, вывод влияет на gate; full Linux evidence обязательно | 17.10 |
| CI-ROOTFS-OS /16 `environment-*/rootfs.json` |38 package/version сочетаний,729 source tuples; точные installed/fixed и scopes в реестре | Полный post-install inventory не означает выполнение каждого пакета. Права runner дают путь к source/output. Адресно исправлять либо доказательно устранять ненужное ПО; текущий обязательный gate сохранён | 20.10 |
| CI-ROOTFS-LANG / те же rootfs reports |184 package/version сочетания,825 source tuples; точные installed/fixed в реестре | Языковые SDK, инструменты и fixtures runner. Нельзя ни объявить всё эксплуатируемым, ни списать как «только CI». Квалифицировать executable path, input, permissions и влияние на output; blanket исключений нет | 20.10 |

C/H counts — package findings исходного D5.1.6, не число уникальных CVE и не новый scan неизменившихся artifacts. Gosu и Gitleaks — разные бинарники; finding с одним ID не имеет общего disposition для них. Нулевой OS scan также не доказывает полноту проверки source-built PostgreSQL. Полный production inventory и все fixed versions сохранены отдельно в `upstream/production-groups.json`.

## Предложение policy по назначению — НЕ активировано

1. Production: exact digest каждого из четырёх runtime, architecture и entrypoint/config; H/C блокируют до исправления или индивидуального owner decision. Internet-facing ingress и startup gosu имеют разные exposure, но оба входят в обязательный runtime gate.
2. Build worker/stages и реально исполняемые CI tools: обязательная отдельная квалификация с учётом входов, сети, privileges, доступа к secrets и возможности подмены output. CVE здесь могут скомпрометировать будущий runtime image; отсутствие сервиса в production не основание acceptance. На PR уже contents:read, checkout credentials не сохраняются; release publication отдельный privilege boundary.
3. Full runner rootfs: сохранять действующий обязательный scan и block. Возможное будущее различение executed packages и неисполняемых fixtures потребует полного inventory/path proof и **отдельного одобрения изменения policy**. В этом этапе rootfs не понижается до диагностики, компоненты не исключаются.
4. Raw upstream bases остаются обязательным diagnostic baseline. Любая нехватка scan/DB/identity/inventory означает INCOMPLETE/BLOCKED; timeout не PASS. Unknown/medium/low сохраняются без изменения текущего severity порога.
5. Любой будущий individual disposition: CVE+artifact digest+package version, primary source, точное доказательство применимости, proposed decision, владелец, expiry, controls и reopen trigger. До явного подтверждения и отдельной review реализации gate не меняется. Групповой реестр — очередь remediation, не bulk acceptance.

## Условия первого релиза и решения владельца

Необходимы: (а) подтверждённые runtime digests/новые nginx-t и provenance; (б) все обязательные build/CI qualifications PASS с действующей policy либо отдельно согласованные individual решения и затем отдельно reviewed применение; (в) функциональные/dependency/secret checks нового source, полный16/16 inventory; (г) независимый security review; (д) непрерывная commit→CI→OCI digest→release manifest связь и **отдельное разрешение владельца** на публикацию/первый release. Deployment и D5.2 требуют собственного согласования. Один зелёный ingress scan не даёт Production GO.

Два точных решения, которые остаются владельцу:

1. **Gosu / CVE-2025-68121:** рекомендуется индивидуальный `not_affected` только для gosu SHA256 `52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0` в PostgreSQL amd64 digest `sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`: crypto/tls и affected symbols отсутствуют в сохранённом exact ELF proof. Владелец — владелец проекта, предлагаемая expiry **2026-11-15**, немедленный reopen при смене digest/архитектуры/gosu или новых данных о достижимости. Controls: DB без опубликованного порта, immutable pin, сохранённый raw finding. Ограничения govulncheck описаны выше. **Решение PENDING**, gate не меняется. Остальные24 и другие binaries требуют собственных решений, пакетного acceptance нет.
2. **Остаточный CI:** подтвердить приоритет адресного исправления build/исполняемых инструментов (npm/esbuild/BuildKit, Gitleaks,4H Compose), сохраняя текущие gates. Предлагаемая будущая policy для неисполняемого runner ПО требует отдельного решения после evidence; сейчас общую отсрочку CVE не согласовывать.

## Источники и evidence

- [Официальный Trivy0.76](https://github.com/aquasecurity/trivy/releases/tag/v0.76.0), [Compose5.6](https://github.com/docker/compose/releases/tag/v5.6.0), [Gitleaks8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1): releases metadata и downloads SHA256 сохранены в `upstream/`.
- [OpenSSL CVE-2026-31789](https://openssl-library.org/news/vulnerabilities/index.html#CVE-2026-31789); [nginx advisories](https://nginx.org/en/security_advisories.html); [gosu security](https://github.com/tianon/gosu/blob/1.19/SECURITY.md).
- Локальное новое evidence: `outputs/d5-1-7-20261016/{targeted-verification.json,risk-registry.json,production-analysis.md,tools-candidate.scan.json,ingress-candidate.scan.json,upstream/}`. Raw scanner reports/source evidence не копируются в tracked документы, ненужные дубли и FIX URLs не добавляются.
- Итоговый CI/review текущего HEAD фиксируются в локальном `outputs/d5-1-7-20261016/report.md` после выполнения. До этого полная квалификация нового source **PENDING**, исходная D5.1.6 остаётся valid historical evidence, не current-HEAD PASS.

Production NO_GO. Merge/tag/release/GHCR publish/deploy/mini-PC не выполняются. Docker/данные Mac не затрагиваются. Посторонние untracked сохраняются. COMPLETE не устанавливается.
