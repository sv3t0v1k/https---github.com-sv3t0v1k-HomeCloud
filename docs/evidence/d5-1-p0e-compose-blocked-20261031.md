# D5.1-P0E — Docker Compose CI: BLOCKED

31.10.2026. Base `1cecfc82ae29c23f13ad8ce24a93a65b4a72a63d`. Обновление CI Compose pins **не выполнено**: требование 0 Critical / 0 High недостижимо на последнем официальном бинарнике. Security gates, Compose YAML, приложения и production не изменены.

## Исходный exact binary

CI использует официальный Compose **5.6.0**, linux/amd64 ELF SHA256 `40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a`, Go **1.26.8**, `golang.org/x/net v0.58.0`. SHA совпал с [официальным `.sha256`](https://github.com/docker/compose/releases/tag/v5.6.0) и `executed-tools/compose` из [D5.1 run 41037761822](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41037761822), artifact `environment-configuration-1`.

Предыдущая оценка **4 High** устарела: raw `tools.json` этого run содержит у Compose **0C/5H**. Это `CVE-2026-111943`, `CVE-2026-78667`, `CVE-2026-78669`, `CVE-2026-97031` в Go stdlib и отдельный `CVE-2026-78669` в x/net. Raw JSON SHA256 `a1da570ff047b4318bc8c96f04b6a00f50785626201733fbbfcb287524ec73ff`. [Сжатая копия](./d5-1-p0e-compose/d5-1-41037761822-tools.json.gz) сохраняет также findings Trivy как другого executed tool; они не приписываются Compose. Повторный адресный Trivy на exact 5.6.0 ELF дал те же **0C/5H**, raw JSON SHA256 `0a0896594f576996c9622fa237ec86acdd29f487a2cf51c1d37e9c2025aab135` ([scan](./d5-1-p0e-compose/compose-5.6.0.scan.json.gz)).

## Официальный кандидат 5.6.1

[Последний официальный релиз v5.6.1](https://github.com/docker/compose/releases/tag/v5.6.1) содержит linux/amd64 ELF SHA256 `47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0`: локальные bytes совпали с release API, `checksums.txt` и индивидуальным `.sha256`. Официальный Sigstore bundle криптографически проверен `cosign verify-blob` с issuer `https://token.actions.githubusercontent.com` и identity `https://github.com/docker/github-builder/.github/workflows/bake.yml@58cb9f5b71b1836d6f690c1e95effdeb9b98cb8a` (`Verified OK`). Release provenance subject содержит тот же SHA256 и source `docker/compose.git#refs/tags/v5.6.1`; он прочитан как upstream statement, отдельной криптографической проверкой этого statement не назван.

`file` подтверждает статически связанный ELF x86-64. `go version -m` подтверждает Go **1.26.10**, Compose **v5.6.1**, `GOOS=linux`, `GOARCH=amd64`, 107 dependency modules, `golang.org/x/net v0.58.0`, `vcs.revision=6cbc19a3fd59e305fb814dca4d854a4fb67d2941`. Go1.26.10 устраняет четыре stdlib findings старого ELF. Но [GO-2026-6611](https://pkg.go.dev/vuln/GO-2026-6611) требует **x/net v0.60.0** для `CVE-2026-78669`; `v0.58.0` остаётся уязвимой.

Свежий Trivy **0.76.0** (DB UpdatedAt `2026-10-30T19:07:50Z`, [metadata](./d5-1-p0e-compose/trivy-db.json)) на exact 5.6.1 ELF: **0C/1H**; единственный High — `CVE-2026-78669`, `golang.org/x/net v0.58.0 → v0.60.0`. Raw JSON SHA256 `10fad873c2dc964504fb8233b7deabac42f8a4d0891d0cd5ba1a0161ec583e16` ([scan](./d5-1-p0e-compose/compose-5.6.1.scan.json.gz)). Неизменённый `scan-policy.py --component` вернул `BLOCKED` и exit 1. Более нового официального Compose release на 31.10.2026 нет.

## Совместимость и граница решения

Точный 5.6.1 ELF в disposable linux/amd64 контейнере, без сети и запуска сервисов, успешно выполнил `docker compose config --quiet` для четырёх конфигураций: base, local, production, production+project-test. Это проверка синтаксиса и нормализации, не запуск production. Адресная GitHub Actions workflow сохраняет exact binary, checksum, Go module inventory, raw Trivy и Compose config evidence; strict gate обязан завершиться FAIL при 1H. Автоматический PR CI проверяет ветку, но его PASS не делает кандидат квалифицированным.

Решение **BLOCKED / UNVERIFIED**. Не закреплять v5.6.1 в CI. Следующий поддерживаемый путь — дождаться официального Compose release с Go 1.26.10+ и x/net 0.60.0+, проверить Sigstore/checksum и повторить адресный 0C/0H scan и CI qualification. Не использовать самодельный бинарник, исключение CVE или ослабление gate. Release, publish, deploy, полный D5.1 и merge не выполнялись.
