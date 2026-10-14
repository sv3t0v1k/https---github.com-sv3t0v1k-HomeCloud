# D5.1.2 — Node LTS и квалификация образов, 2026-10-14

Решение в этой области: **BLOCKED**. Поддерживаемый Node24 и immutable image pins подготовлены, реальные scans обнаружили high/critical; исключений нет. Production NO_GO сохраняется. Локальная квалификация новых application images не заявляется: сборка/smoke/OCI provenance исполняются на disposable GitHub runner после безопасного push.

## Версии и происхождение pins

[Официальная Node download](https://nodejs.org/en/download) указывает24.21.0 LTS,20.20.2 EOL. [Расписание Release WG](https://github.com/nodejs/Release) подтверждает поддержку24.x до2028-04-30. CI/frontend/security используют exact24.21.0; backend CI — glibc24.21.0-bookworm-slim, production build/runtime — musl24.21.0-alpine. Slim оставляет требуемую Linux/glibc среду, убирая ненужные инструменты полного bookworm; gcc/libc6-dev/git/python3/util-linux явно устанавливаются CI. Native Node-API совместимость и полный Nest/TS regression проверяет свежий CI, прежний Node20 result не считается доказательством.

[Официальный nginx download](https://nginx.org/en/download.html) указывает stable1.30.5 и legacy1.28. [Security advisories](https://nginx.org/en/security_advisories.html) требуют1.30.4+ для map/regex CVE-2026-42533; поэтому frontend/будущий ingress pin переведён на1.30.5-alpine. Добавлен runner-only nginx template `nginx -t` с loopback backend и synthetic ingress; пользовательский сервис не запускается. PostgreSQL остаётся major16; актуальный16-alpine digest совпал с прежним, смены DB major нет.

`images.lock.json` хранит upstream index digests, Dockerfile defaults используют те же immutable references. CI Node container отдельно pinned AMD64 child digest. `images.platforms.json` связывает index→AMD64 manifest. Docker Hub Registry API дал ровно один linux/amd64 descriptor на каждый index; повторно скачанный child manifest проверен SHA256 относительно descriptor, config сообщает os=linux/architecture=amd64. [Metadata final pins](./base-image-metadata.json), [первоначальное сравнение](./base-image-metadata-before.json). Node24 binary для локальных package checks скачан из nodejs.org в/private/tmp, SHA256 проверен против официального SHASUMS; глобальная Node20 установка не менялась.

## Реальный scan

Scanner — официальный **Trivy0.75.0**, immutable release опубликован2026-10-01. [Release](https://github.com/aquasecurity/trivy/releases/tag/v0.75.0), [официальный инцидент и безопасное pinning](https://github.com/aquasecurity/trivy/discussions/10425). GitHub API подтверждает immutable=true. Linux archive SHA256`c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f`; локальный macOS-ARM64 archive`4a77108cccf8e55c8d6823e1e759939a622277e66cd0daa3c1fc621ed69e4568`, оба из official asset metadata; локальный checksum PASS. GitHub Actions Trivy не используется. DB version2, UpdatedAt2026-10-14T07:11:52Z, download09:39:41Z; [metadata](./trivy-db-metadata.json).

Локально действительно выполнен remote scan exact pinned references с platformlinux/amd64, без Docker daemon/pull/run. Сохраняются все OS/language severities; no ignore-unfixed, no ignore file, no audit allowlist. Scanner/infrastructure error fail-closed. Новый CI обязательный `base-image-scan` повторяет все четыре scans независимо; `image-build` дополнительно сканирует фактически собранные backend/frontend images. Все JSON reports загружаются artifacts даже при failure; high/critical блокируют общий gate.

| Образ | Critical | High | Medium | Low | Unknown | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Node24.21.0-alpine |0|8|13|1|0|BLOCKED|
| nginx1.30.5-alpine |0|3|3|0|0|BLOCKED|
| PostgreSQL16-alpine |1|24|28|3|5|BLOCKED|
| Node24.21.0-bookworm-slim CI |4|60|113|84|1|BLOCKED|

Это package-level scanner findings, включая повторения CVE на разных пакетах, а не число доказанных exploit paths. [Сводка с packages/versions/fixes/status](./base-scan-summary.json). Raw JSON и logs: `image-base-node`, `image-base-nginx`, `image-base-postgres`, `image-base-node-ci`. Все четыре scanner exits1 из-за security gate; валидный JSON имеется. Дополнительная [проверка gate](./scan-gate-verification.json) подтверждает platform/OS-scan и ожидаемый BLOCKED каждого реального report.

NodeAlpine high находятся в bundled npm: brace-expansion, http-cache-semantics, ip-address, tar, undici. Для http-cache-semantics fixed version отсутствует. Npm нельзя механически удалить из production runner: `backend/docker/entrypoint.sh` запускает migrations через `npm run migration:run`, operator contract также использует npm. Никакой подмены entrypoint/contract в этой задаче нет. nginx high: libexpat2.8.4-r0→2.8.5-r0, pcre210.48-r0→10.49-r0, tiff4.7.1-r0→4.7.2-r0. PostgreSQL high/critical находятся в embedded Go stdlibv1.24.6 файла/usr/local/bin/gosu; OS scan отдельно содержит medium. CI Debian содержит high/critical OS и тот же bundled npm; часть vendor status affected/fix_deferred/will_not_fix, поэтому простое обновление base digest не доказывает устранение.

Проверен один bounded выбор свежих LTS/stable и slim; дальнейшая переборка images ради zero не делалась. Реальная release qualification требует адресной remediation/upstream replacement и повторного scan; findings не скрыты, risk acceptance не утверждена. Владелец решения — sv3t0v1k; повторная triage до2026-10-21, до remediation release остаётся заблокирован.

## CI/provenance и локальные проверки

Actionlint1.7.12 с disabled external shellcheck — PASS; shell syntax и diff whitespace — PASS. `image-build` сохраняет существующий Linux/amd64 secure-fs/Sharp smoke, добавляет architecture inspection/nginx template validation, отдельный OCI archive с mode=max/version=v0.2 и проверку standalone validator. OCI/archive строится локально на disposable runner; push=false/load=false, реальный tag/release/GHCR publish не выполняются. Metadata/proofs retained artifacts; archives не загружаются. `provenance-pair` требует оба proof и исполняется даже при downstream image-scan failure; общий gate всё равно fail. В обоих Buildx invocations dirty/auto labels отключены явно; source cleanliness проверяется с forbidden-path exclusion до build. Explicit source/revision/version/role/pair labels сохраняются.

Свежий GitHub result и independent reviewer verdict основная задача дописывает после push/review. Mac рабочий Compose, существующие images/containers/volumes, mini-PC и другие Docker приложения не изменялись. Запрещённый audit не читался/не искался/не хешировался. Независимые агенты владеют dependency/provenance policy; этот отчёт не заменяет их review.

## Первые фактические CI incidents и адресная коррекция

Push run38545262386 на8a9add6: backend checkout после успешного apt завершился `server certificate verification failed. CAfile: none CRLfile: none`. Slim image не содержит системного CA bundle; `apt-get --no-install-recommends` не подтянул его через git. Добавлен явный `ca-certificates`; проверка TLS не отключается. [Raw job115789621456](./incident-node-slim-checkout.log).

Frontend image в том же run собран; entrypoint templates отработали, `nginx -t` сообщил syntaxOK, затем failed `chown("/var/cache/nginx/client_temp",101): Operation not permitted`. Причина — cap-dropALL в новой syntax-check harness. Добавлен толькоCHOWN на disposable runner container: networknone/no mounts/no-new-privileges остаются, сервис не запускается. Проверяется полный штатный `nginx -t`, app config не меняется. [Raw job115789621803](./incident-nginx-smoke.log). Образ фактически просканирован несмотря на syntax harness failure:3high/3medium, BLOCKED.

Эти failures сохранены; обе коррекции actionlint/diff-whitespace PASS, повторный runtime result необходимо подтвердить свежим GitHub CI. Локальный Docker daemon для воспроизведения не использовался. Результат предыдущего failed run не заменён PASS.
