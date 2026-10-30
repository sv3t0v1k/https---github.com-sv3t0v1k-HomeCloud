# D5.1-P0D — BuildKit: BLOCKED

31.10.2026. База `b2d7abb3f999a63aed8a2bd4560ccec826b28e33`. **Production NO_GO.** Immutable pins, приложения, Compose, security gates и CVE-политика не изменены. Release, публикация, deploy и полный D5.1 не выполнялись.

## Исходное состояние

[D5.1 run 41037761822, `support-image-buildkit-1`](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41037761822): raw Trivy **1 Critical / 116 High**, 31 уникальный CVE. Exact linux/amd64 manifest `sha256:98cc6a3fc46220d00f8224ae483f3274fc874e9be8d7dd1e2e2c5481209228b5`, config `sha256:27933730df224df80c41f4e5a9b33fa78831a79fd31903df3bb7deb49363422f`, сохранённый OCI archive `sha256:81ff1d0292a1d9935659e189270813ecad83ca8e6260fb178573ba3f00ef58f5`. Binding artifact фиксирует `ARCHIVE_MANIFEST_CONFIG_SCAN_VERIFIED`; это доказательство идентичности исходного scan, не безопасности образа.

| Цель | Raw C/H и версии | CVE / исправление |
|---|---|---|
| Alpine 3.23.6 | 1C/3H | `CVE-2026-111497` brotli-libs 1.2.0-r0 → 1.2.1-r0; `CVE-2026-92392` libcurl 8.22.0-r0 → 8.23.0-r0; `CVE-2026-77214` libexpat 2.8.5-r0 → 2.9.0-r0; `CVE-2026-103111` pcre2 10.48-r0 → 10.49-r0. Версии сверены с [Alpine v3.23 secdb](https://secdb.alpinelinux.org/v3.23/main.json). |
| Четыре `buildkit-cni-{bridge,firewall,host-local,loopback}` | по 23H, всего 92H; stdlib Go 1.25.7 | `CVE-2026-111943`, `CVE-2026-25679`, `CVE-2026-27145`, `CVE-2026-32280`, `CVE-2026-32281`, `CVE-2026-32283`, `CVE-2026-33811`, `CVE-2026-33814`, `CVE-2026-33818`, `CVE-2026-39820`, `CVE-2026-39821`, `CVE-2026-39822`, `CVE-2026-39836`, `CVE-2026-42499`, `CVE-2026-42504`, `CVE-2026-56853`, `CVE-2026-56858`, `CVE-2026-56859`, `CVE-2026-56860`, `CVE-2026-56862`, `CVE-2026-78667`, `CVE-2026-78669`, `CVE-2026-97031`. Для всей группы нужен как минимум исправленный Go 1.26.10 в ветке 1.26 или 1.27.3 в ветке 1.27; отдельные CVE исправлены раньше. |
| `buildkit-runc` | 10H; stdlib Go 1.26.8, x/net 0.43.0 | stdlib: `111943`, `78667`, `78669`, `97031` с префиксом `CVE-2026-`; x/net: `CVE-2026-25681`, `CVE-2026-27136`, `CVE-2026-33814`, `CVE-2026-39821`, `CVE-2026-46600`, `CVE-2026-78669`. Последний фикс x/net — 0.60.0 по raw scan. |
| `buildkitd` | 6H; stdlib Go 1.26.8, x/net 0.58.0, go-archive 0.2.0 | Те же четыре stdlib CVE; `CVE-2026-78669` x/net → 0.60.0; `CVE-2026-17106` go-archive → 0.3.0 ([upstream advisory](https://github.com/moby/go-archive/security/advisories/GHSA-hfg8-hc9c-6c3h)). |
| `buildctl` | 5H; stdlib Go 1.26.8, x/net 0.58.0 | Те же четыре stdlib CVE; `CVE-2026-78669` x/net → 0.60.0 ([Go advisory](https://pkg.go.dev/vuln/GO-2026-6611)). |

Указанные counts — package findings по восьми targets, а не число уникальных CVE. Исправление `CVE-2026-111943` подтверждено [Go advisory](https://pkg.go.dev/vuln/GO-2026-6809). Наличие модуля в бинарнике не доказывает достижимость уязвимого пути; действующий raw 0C/0H gate от этого не меняется.

## Проверенный официальный v0.34.1

[BuildKit v0.34.1](https://github.com/moby/buildkit/releases/tag/v0.34.1) — последний официальный release на дату проверки. Проверен опубликованный `moby/buildkit:v0.34.1`, а не только тег: OCI index `sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c`, linux/amd64 manifest `sha256:b651bf250c2805569f1db385ad1ea8fb73737dfc851de305f274ca02690fa93f`, config `sha256:2a2c53740b68d6a814cfed5af9f6d9a8eaec67a8546058c226a8251ad4680450`, локальный OCI archive `sha256:8e4c9be5a4dd482377fbea7be827e3dbd4cc43efe2476ae945079b6d34ed5ae2`. OCI manifest указывает source revision `f5b59a1f2fb25a0cb7072c398cab9aed7835da4e`; приложенный in-toto/SLSA manifest `sha256:73705a03333e6ffb9e9fbeb6c85656fe5defbe6b145a8ebdd533cb95ddc3d357` имеет subject того же amd64 digest и source tag object `401bf63d02833b70ef9393eb9702e2b5648dfaaf`, который указывает на этот commit. Наличие attestation проверено, её подпись отдельно не квалифицировалась: кандидат уже нарушает security gate.

| Бинарник в exact OCI | `go version -m` | SHA256 ELF |
|---|---|---|
| buildkitd | Go 1.26.10; BuildKit 0.34.1; x/net 0.59.0; go-archive 0.2.0 | `ca3c5d4fe1defc5df56631e179824f17ddd555f1fcf5057d14dfb87496baa8c3` |
| buildctl | Go 1.26.10; BuildKit 0.34.1; x/net 0.59.0 | `8e64362dceba989827b23af567915feda10426ebd40611772318662e33bf2bfd` |
| buildkit-runc | Go 1.26.10; runc 1.5.2; x/net 0.55.0 | `2f5ed1fb8b0d57bf8442767d572229cb0ff29bdcfe279c6a51535a6a84f85eff` |
| buildkit-cni-bridge | Go 1.25.7; CNI plugins 1.9.1 | `3553f5e8f47ed62aec728ab6f7444f6bf1624f916769852c6deb52cd216e22ba` |
| buildkit-cni-firewall | Go 1.25.7; CNI plugins 1.9.1 | `ecbd112d77192a125e85ab1fa4ded6cfaf4e9732172e072ee248caa81eba7aed` |
| buildkit-cni-host-local | Go 1.25.7; CNI plugins 1.9.1 | `ac5ff19b1120bd1d58203b20d45165f244691fcf9776ba55d6dd1747f043c90f` |
| buildkit-cni-loopback | Go 1.25.7; CNI plugins 1.9.1 | `02956bdd03b9b71693b3efd72afce88384e4472b644a1c6410fe817f618c1a83` |

Релиз обновил Go для собственных бинарников и runc, но [официальный Dockerfile v0.34.1](https://github.com/moby/buildkit/blob/v0.34.1/Dockerfile) берёт готовые CNI plugins v1.9.1 из [последнего CNI release](https://github.com/containernetworking/plugins/releases/tag/v1.9.1); они всё ещё собраны на Go 1.25.7. Обновлённый `buildkitd` также сохраняет go-archive 0.2.0 и x/net 0.59.0, а runc — x/net 0.55.0.

Свежий Trivy 0.76.0 с DB `UpdatedAt=2026-10-30T19:07:50Z`, `DownloadedAt=2026-10-30T23:15:40Z` просканировал exact OCI layout: **1 Critical / 98 High, 27 уникальных CVE**. Из них 92H — CNI stdlib; остальные 1C brotli, 1H curl, 1H buildctl x/net, 2H buildkitd (go-archive/x/net), 2H runc x/net. libexpat и pcre2 в этом образе уже исправлены. [Raw scan](./buildkit-v0.34.1-trivy.json.gz) сохранён с SHA256 сжатого файла `136b6b3381a69e2c9b5d65265d8de44bc87b55eb8ff3ecd6e41f8060a788018a`; SHA256 JSON `5b44c7c54d62fed152e5a4f5e8fe0d9f2ea83a5f04df14d208784af8aa8aaf63`. Первоначальный `trivy --input` не распознал OCI tar; после диагностики была одна корректировка на OCI layout directory, скан прошёл. **0C/0H не подтверждён.**

## Решение и проверки

Готового официального BuildKit, проходящего raw gate, нет. v0.34.1 не закрепляется ни в `scripts/ci/production-images.lock.json`, ни в двух Buildx workflows. Адресная PR-квалификация и реальные backend/frontend Buildx-сборки не запускались: заведомо уязвимый OCI нельзя объявлять release-кандидатом или PASS. Для разблокировки нужен официальный OCI с исправленными CNI (Go 1.26.10+ в ветке 1.26 либо 1.27.3+ в ветке 1.27), x/net ≥0.60.0, go-archive ≥0.3.0 и Alpine brotli/curl, затем exact source/supply-chain binding, свежий 0C/0H и Buildx/provenance/output тесты без публикации. Срок такого release неизвестен. Вариант индивидуального disposition — только отдельное предложение владельцу, не изменение политики.

Локально прошли `test-oci-scan-binding.py` (9), `test-scan-policy.py` (8), `test-scan-evidence.py` (10), `test-policy-coverage.py` (15); raw baseline и candidate counts пересчитаны из JSON. Полный D5.1, lint/build и адресный P0D qualification Actions run не запускались: код и workflows не изменены, квалифицированного image нет. Автоматический PR CI отражается отдельно в описании PR. Текущий production pin и его **1C/116H** остаются. Итог **BLOCKED**, не QUALIFIED.
