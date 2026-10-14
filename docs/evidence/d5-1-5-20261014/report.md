# D5.1.5 — точные артефакты и минимальные условия релиза

2026-10-14. Исходный HEAD `3cbd2a1`, PR №1 draft. **BLOCKED; Production NO_GO.**
Gate, application/Compose/workflow source и статус COMPLETE не изменены. Mini-PC,
Mac Docker, реальные данные и запрещённый audit не читались/не изменялись.
Фактическое deployed состояние не проверялось и не выводится из registry metadata.

## Проверенные образы

Полные идентификаторы, scanner identity и ограничения: [production-images.json](./production-images.json).
Все проверенные configs — linux/amd64. Короткие SHA ниже обозначают разные типы digest.

| Роль | Проверенная идентичность | Что установлено |
|---|---|---|
| Backend | CI config `60bf4fce…`; offline platform manifest `aef42129…` | Scan CI образа 0C/0H/2M, 18 OS +329 Node package records. Offline digest относится к отдельной labelled сборке; связь с этим scan не доказана |
| Frontend | CI config `4cdf44ab…`; offline platform manifest `2243669d…` | Scan CI образа 0C/0H/2M, 71 OS package. То же ограничение отдельной offline сборки |
| PostgreSQL | index `721873c3…`, amd64 manifest `1a66d744…`, config `81bd698b…` | PG16.15, 45 OS и4 Go module records. Scan raw1C/24H/28M; все H/C — gosu; бинарная квалификация ниже |
| Ingress | index `a8b39bd9…`, amd64 manifest `0dcc8882…`, config `dc73b49f…` | Текущий snapshot nginx:1.28-alpine = nginx1.28.3-r1/Alpine3.23.3. Единственный новый image scan:2C/60H/97M/50L/2UNKNOWN |

Backend/frontend source этих D5.1.4 PR builds — synthetic merge commit
`2a01cc812bed10a7ba96769d3dce2524b1e8edec`, не branch HEAD3cbd2a1. Config ImageID
не равен registry platform manifest digest. Offline OCI archives не сохранены в
загруженных artifacts, GHCR публикации нет. Поэтому четыре утверждённых production
digests сейчас не существуют как доказанный release contract. Значения env
RELEASE_BACKEND_IMAGE/FRONTEND_IMAGE и live deployment неизвестны; секретные env не читались.

Production Compose всё ещё содержит floating postgres16-alpine и ingress1.28-alpine.
Ни snapshot тега, ни совпадение исходников не доказывает установленный на mini-PC digest.
PG base qualification относится к точному выбранному кандидатному digest, а не live PG.
Redis исключён специальным unqualified-production profile; не часть первого релиза.

## PostgreSQL / gosu: бинарное доказательство

Из точного amd64 manifest извлечён **реальный ELF**, без выполнения контейнера:
gosu SHA256 `52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0`.
Buildinfo: gosu1.19.0, Go1.24.6, CGO_ENABLED=0, GOOSlinux/GOARCHamd64.
Manifest/config/все слои сверены SHA256; config совпадает с исходным Trivy ImageID.

Официальный pinned govulncheck1.9.0 проверил этот бинарник: **0 symbol findings**,
3 package-level и54 module-level vulnerabilities. Его streaming JSON содержит65
finding events/57unique OSVs, а не65 достижимых уязвимостей и не ноль raw findings.
Все25 исходных H/C CVE присутствуют в dataset; по каждой пересечение affected functions
с извлечёнными символами пусто: [индивидуальная таблица](./pg-per-cve-binary-evidence.json).
База vuln.go.dev: last_modified2026-10-08T22:31:09Z, значение сохранено, не подменено
свежестью Trivy DB. Текущая проверка dataset явно включает все25 интересующих CVE.

Для **CVE-2025-68121 / GO-2026-4337** JSON содержит только stdlib module-level match.
Среди2962 извлечённых символов/51 package отсутствуют функции crypto/tls. Extractor
учитывает также inline functions. Следовательно, уязвимый TLS код не обнаружен
в этом конкретном gosu, что существенно сильнее прежнего анализа исходников.
Это кандидат на индивидуальный not-affected disposition, **не принятое исключение**.
Полноценный runtime call graph не строился; ограничения extractor/metadata остаются.
Вывод не распространяется на другой digest/архитектуру, PostgreSQL core/extensions
или состояние данных. Подробный метод: [pg-METHOD.md](./pg-METHOD.md).

Отдельно проверены реальные archive headers: отсутствуют relevant whiteouts/root
opaque и redirecting ancestors. Это подтверждает точное извлечение данных из этих
образов; использованный узкий extractor не считается универсальным OCI unpacker.
См. [archive-path-review.json](./archive-path-review.json).

## Ingress: counts не равны доказанной эксплуатации

Проверены SHA256 manifest/config/всех слоёв. Из APK database извлечены72 пакета —
точное совпадение со scan inventory. Nginx ELF64/EM_X86_64, nginx1.28.3-r1,
libcrypto3/libssl3 3.5.5-r0, pcre2 10.47-r0. Все findings и installed/fixed versions
сохранены в [исходном scan](./ingress-scan.json); DB freshness sidecar PASS.

- Две CRITICAL записи — один CVE-2026-31789 в libcrypto3/libssl3. [OpenSSL advisory](https://openssl-library.org/news/secadv/20260407.txt)
  ограничивает его32-bit platforms; ELF64 подтверждён. Это индивидуальный кандидат
  not-affected для этого image, не автоматическое снижение severity/исключение.
- Для четырёх nginx H — CVE-2026-42055/42533/60005/9256 — проверенные templates
  не содержат нужных HTTP2 upstream/grpc, regex-map captures, slice или capture-based
  rewrite соответственно. Проверка относится к repository templates, не live nginx -T.
  [Upstream advisories](https://nginx.org/en/security_advisories.html) и текущий config
  поддерживают условную неприменимость; решения пока не приняты.
- CVE-2026-49975 имеет описание Apache, но официальная Alpine secdb явно связывает
  его с nginx fix1.28.3-r3. Несоответствие не объявлено false positive и остаётся
  неразрешённым; HTTP2 в checked config не включён. Новых попыток расследования нет.
- Остальные55 H не получили бинарной/runtime квалификации. Это unresolved findings,
  а не утверждение об эксплуатации всех55. Нельзя выпускать этот ingress, просто
  вычеркнув две CRITICAL записи. Для корректируемых пакетов доступны записанные fixes;
  исправленный exact image и TLS/config smoke ещё не проверены. Образ не менялся.

## Реальные build/CI отдельно от production

[Узкая квалификация](./build-ci-qualification.md) сопоставляет фактический post-apt
inventory с baseline scan:161 пакет против88, добавлены73; среди исходных изменён
только perl-base u3→u4. Доказаны исправления3C+4H по FixedVersion. Raw4C/60H не являются
результатом scan обновлённого CI. CVE-2026-9538 в Archive::Tar остаётся кандидатом
реальной CI экспозиции: perl-modules установлен, API/input reachability не доказана.

Глобальный npm toolchain используется build/deps и CI, но отсутствует в backend runner.
Для промежуточных stages нет сохранённых manifests/inventory/scans; динамический
apk install не позволяет восстановить точные старые версии по Dockerfile.
Frontend test CI — отдельный hosted Ubuntu/setup-node, не Bookworm job container.
Эти пробелы влияют на доверие к release artifact и не закрываются runtime0H.

## Минимальное изменение gate — ТОЛЬКО ПРЕДЛОЖЕНИЕ

Сейчас существующий gate полностью сохранён; код исключений не создавался.
Предлагается изменить только единицу блокировки: raw upstream base → **фактически
исполняемый exact артефакт**, сохранив raw scans как видимый обязательный baseline.
Блокирующими остаются четыре production images и отдельная qualification build/CI.
Неполное покрытие или любой **неразрешённый** H/C продолжает блокировать release.
Разделение build/CI не означает перевод этих рисков в неблокирующие по умолчанию.

Никакого allow-all stdlib, Go, build-only или severity исключения. Not-affected/risk
disposition требует отдельной записи на каждую CVE/package/image digest/architecture,
evidence и явного решения владельца. Срок — предложенные30дней, с немедленной
инвалидацией при смене digest или новых релевантных advisory/функциональности.
Это касается и25 gosu записей: таблица — набор предложений, не batch approval.
Переход rawbase в diagnostic-only допустим **только после** полного downstream coverage
и явного согласования политики. Пока это условие не выполнено, активировать его нельзя.

## Что действительно блокирует первый релиз

1. Не выбран и не связан с scan один exact OCI artifact для каждой production роли;
   отдельно выбран approved source revision, а не молча synthetic merge build.
2. Ingress требует исправленного квалифицированного image либо индивидуальных
   dispositions всех остаточных H/C; полных доказательств сейчас нет.
3. Gosu25 и scoped ingress false-positive candidates ждут индивидуальных решений;
   отрицательный symbol result не изменил действующий Trivy gate.
4. Нет scan фактических post-install build/CI variants и added packages/global tools;
   npm/Archive::Tar и другие unresolved tool findings не приняты автоматически.
5. Политика изменения rawbase gate не согласована. До этого raw4base failures
   самостоятельно блокируют действующий CI независимо от перечисленных уточнений.

Для первого релиза нужны локально/в CI сохранённые exact OCI archives с привязанными
scan→manifest→config→platform→source и package inventories, pin4production roles,
квалификация ingress и PG16, адресные решения CVE и затем один итоговый CI.
Это не разрешение на publish/deploy или работу с реальными данными.

Новый код приложения/CI не менялся; полный test suite/build не повторялся без причины.
Выполнены только SHA256/identity/inventory/symbol/advisory проверки и один новый
ingress image scan. Два govulncheck представления — предел проверок одной проблемы.
Независимый review сохраняется отдельным файлом после проверки этих формулировок.
