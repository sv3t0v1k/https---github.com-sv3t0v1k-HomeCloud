# D5.1-P0C — PostgreSQL/gosu: BLOCKED

31.10.2026, Владивосток. Base `de7de263aff537b345c3dd75f24a075f15dbe086`. **Production NO_GO.** Образ, Compose, security gates и политика не изменены. Полный D5.1, публикация и deploy не выполнялись.

## Причина

[Run 41037761822, `support-image-postgres-1`](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41037761822) содержит 1 Critical и 25 High, все в `stdlib v1.24.6` бинарника `/usr/local/bin/gosu`. Exact production amd64 manifest `sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`, config `sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542`, gosu ELF `sha256:52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0`. Сверены raw scan, OCI binding и SHA официального [gosu 1.19 amd64 release](https://github.com/tianon/gosu/releases/tag/1.19); `go version -m` подтвердил `go1.24.6`, linux/amd64 и upstream module `v1.19.0`. Finding по модулю не доказывает достижимость каждой функции, но действующий raw 0C/0H gate остаётся BLOCKED.

| Группа | Конкретные CVE | Подтверждённое upstream исправление |
|---|---|---|
| 1 Critical | CVE-2025-68121 | Go 1.24.13 / 1.25.7; существующая индивидуальная disposition относится только к старому exact ELF и не меняет raw gate |
| 24 High | CVE-2025-61726, CVE-2025-61729, CVE-2026-25679, CVE-2026-27145, CVE-2026-32280, CVE-2026-32281, CVE-2026-32283, CVE-2026-33811, CVE-2026-33814, CVE-2026-33818, CVE-2026-39820, CVE-2026-39821, CVE-2026-39822, CVE-2026-39836, CVE-2026-42499, CVE-2026-42504, CVE-2026-56853, CVE-2026-56858, CVE-2026-56859, CVE-2026-56860, CVE-2026-56862, CVE-2026-78667, CVE-2026-78669, CVE-2026-97031 | Все исправлены не позже Go 1.26.9 по raw scan; это не доказывает чистоту пересобранного image |
| Новый 1 High | [CVE-2026-111943 / GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809) | Go 1.26.10 или 1.27.3; старый эксперимент Go 1.26.9 недостаточен |

[PostgreSQL 16.15](https://www.postgresql.org/docs/release/) остаётся текущим minor PG16. Текущий [официальный Alpine Dockerfile](https://github.com/docker-library/postgres/blob/master/16/alpine3.24/Dockerfile) и [Debian Dockerfile](https://github.com/docker-library/postgres/blob/master/16/trixie/Dockerfile) устанавливают тот же gosu 1.19. OCI config проверенного `16.15-alpine3.24` также задаёт `GOSU_VERSION=1.19` и скачивает gosu из этого upstream release. Смена Docker-тега не доказывает устранение Go CVE.

[Go 1.26.10 и 1.27.3 выпущены](https://go.dev/doc/devel/release), но [последний официальный gosu release — 1.19](https://github.com/tianon/gosu/releases) с Go 1.24.6. Готового поддерживаемого PG16+gosu image с подтверждённым 0C/0H сейчас нет. Существующий экспериментальный [рецепт](../../ops/postgres/README.md) использует Go 1.26.9, его OCI provenance **UNSIGNED**, полная воспроизводимость OCI **UNPROVEN**, выбранный BuildKit остаётся под блокирующим security gate. Его прежний PASS нельзя перенести на новый CVE или digest.

[D5.1.5](./d5-1-5-20261014/pg-per-cve-binary-evidence.json) сохранил exact ELF evidence по прежним 25 findings, [D5.1.7](./d5-1-7-security-triage-20261016.md) предложил индивидуальное решение по Critical. В текущем artifact оно активно только для старого exact ELF, не меняет raw gate и не распространяется на новый CVE. [D5.1.10–12](./d5-1-10-postgres-gosu-20261017.md) проверяли экспериментальный Go 1.26.9 image до появления CVE-2026-111943. `ops/postgres/qualification.lock.json` прямо фиксирует `production=NO_GO`, `signature=UNSIGNED`, `full_oci_reproducibility=UNPROVEN` и `builder_status=BLOCKED_EXISTING_SECURITY_GATE`.

## Проверка этого решения

Raw artifact повторно разобран: 26 уникальных CVE (1C/25H), все `stdlib v1.24.6`; перечень выше совпадает без пропусков. Локально прошли `scripts/ci/test-gosu-disposition.py` (11 тестов) и `ops/postgres/test_prepare.py` (8 тестов). Нового OCI и disposable PGDATA нет, поэтому Trivy 0C/0H, initdb, healthcheck, запись/чтение и рестарт нового image **не проверены**. Адресный Actions run не запускался: квалифицировать и архивировать как кандидат нечего. Результат — **BLOCKED**, а не PASS.

## Варианты и условия разблокировки

1. Дождаться официального gosu release, пересобранного исправленным Go, и PG16 image с новым digest. Затем адресно проверить весь image и контракт БД. Риск — срок выпуска неизвестен; текущий production pin остаётся с raw 1C/25H.
2. Отдельно квалифицировать собственную сборку gosu 1.19 из pinned upstream commit с exact pin официального Go 1.26.10+ в ветке 1.26 либо 1.27.3+ в ветке 1.27, проверенными SHA/подписями исходников, toolchain, модулей и builder; создать проверяемую provenance/attestation нового OCI. Проверить полный бинарный inventory и свежий Trivy 0C/0H, затем disposable initdb, UID/GID/entrypoint/PGDATA, healthcheck, запись/чтение, рестарт и сохранность данных. Риск — собственное сопровождение и новый trust boundary; прежний эксперимент/unsigned JSON не являются такой цепочкой.

Индивидуальная disposition для любого оставшегося finding может быть только отдельным предложением владельцу. В этом P0C исключений, ослабления gate и переноса старой disposition нет. До нового exact image, проверяемой supply chain и полного адресного PASS решение **BLOCKED**, а не QUALIFIED.
