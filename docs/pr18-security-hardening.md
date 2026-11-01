# Локальная квалификация security hardening PR #18

Исходная ветка: `тестовый-канал-обновлений`, исходный commit
`0720e8c4e390edc74a3f2c854de16f4899b11883`. Изменения не опубликованы.

## RCA после локального hardening `415c5d1`

Первый набор результатов ниже сохранён как история. Разбор полных журналов
показал ошибки локального окружения, а не подтверждённые регрессии hardening.
Исходники приложения и тесты ради PASS не изменялись; security gates сохранены.

| Первоначальный FAIL | Первопричина | Сравнение с baseline | Исправление |
|---|---|---|---|
| Backend: rate-limit 13, workspace 11, cleanup interceptor 4, secure-filesystem 10 | Все 38 тестов достигают Linux-only SecureFilesystem на macOS. HTTP 500, lifecycle timeout, открытые handles и close(undefined) — последствия раннего отказа, а не независимые ошибки | Guard уже есть в `0720e8c`; все четыре suites проходят в baseline Linux CI | Выполнить полный набор на Linux с собранным native module; не ослаблять guard и не пропускать suites |
| Frontend: PublicUploadPanel, 1 | Установлен Vitest/@vitest/spy 3.2.7 вместо закреплённого 4.1.11. При restoreMocks старая версия сбрасывает factory mock hashFileSha256 в undefined, поэтому expectedSha256 отсутствует в запросе | Lockfile baseline уже требует 4.1.11; frontend tree идентичен | Штатный npm ci по существующему lockfile; targeted 7/7 и full 325/325 PASS |
| Dependency security runtime | Установлены direct Multer 1.4.5-lts.2 и Nest nested 2.0.2, хотя lockfile/override требуют 2.5.0. Поэтому identity assertion, multipart limit и crafted field-name защита не соответствуют проверяемому контракту; Invalid array length ведёт к timeout | Backend package/lock неизменны; baseline CI runtime 7/7 PASS | Штатный npm ci восстановил единый Multer 2.5.0; runtime 7/7 PASS, включая malformed multipart |

`git diff 0720e8c 415c5d1 -- backend frontend` пуст. Tree SHA backend обоих
commits: `7f8bb0c3c00b302e92f0493126e316f3e9e3b818`; frontend обоих:
`9717fc7af46164e4b2d4fbac11b2dfa1a7e75941`. Обновления зависимостей
`5f47e0d` и `c80eaa4` предшествуют baseline. Запуск baseline с теми же
неверными зависимостями и macOS имел бы те же причины отказа; отдельный
checkout baseline не создавался и динамический baseline-прогон не заявляется.

Проверены полные журналы baseline
[CI #41310005763](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41310005763):
[backend unit и dependency runtime](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41310005763/job/124859217972)
— 61 suite / 942 tests и runtime 7 PASS;
[frontend](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41310005763/job/124859219320)
— 27 suite / 325 tests PASS;
[integration](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41310005763/job/124859242727)
— 31 suite / 355 tests PASS. Это результаты baseline, не нового HEAD.

Локальное исправление окружения: временный Node 24.21.0 и npm 11.21.1
(версии CI), npm ci --no-audit для backend/frontend. Глобальные инструменты,
package.json и lockfile не менялись. Предыдущий локальный запуск использовал
существующий node_modules без npm ci; эта ошибка методики исправлена. Когда и
каким процессом установлены устаревшие пакеты, по доступным данным не установлено.
Проверка npm ls после восстановления:
Multer 2.5.0 deduped, Nest/direct identity true. Отчёт frontend:
`/tmp/homecloud-rca-frontend.json` (success=true, 27 файлов, 325 assertions).
Первоначальный backend журнал `/tmp/homecloud-hardening-unit.log` содержит
дублированный вывод: пересчитаны 38 уникальных failed test names.

Контроль причинности: прежний Node 20.19.4 с восстановленными зависимостями
также дал frontend targeted 7/7 и dependency runtime 7/7 PASS. Смена Node
не была необходимым условием устранения этих двух групп FAIL.

Промежуточная Linux-проверка в Docker Desktop: точный CI linux/amd64 образ
на ARM Mac под эмуляцией дал 38 FAIL в четырёх targeted suites, уже с другой
причиной — native root syscall вернул ENOSYS (Function not implemented).
Это отдельный результат, не macOS platform guard и не доказательство ошибки
приложения. openat2 security boundary и native код не менялись.

### Повторная квалификация

Нативный Linux runner: Docker Desktop, kernel 6.12.76-linuxkit aarch64,
Node 24.21.0, npm 11.21.1. Официальный образ того же tag
node:24.21.0-bookworm-slim, arm64 digest
`sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc`.
Это отклонение по архитектуре от CI linux/amd64; финальный amd64 CI ещё не
запускался. Единственный checkout смонтирован read-only; зависимости, dist и
native binary — в tmpfs overlay; отдельный PostgreSQL без published ports.
openat2 capability probe PASS; четыре исходных проблемных suites — 54/54 PASS.

Первый полный ARM-прогон выявил ошибки подготовки стенда: unit 937 PASS / 5
FAIL (unzip отсутствовал в четырёх тестах; overlay скрывал secure-fs.c в одном),
integration 354 PASS / 1 FAIL (unzip). После установки штатного CI tool unzip
и открытия того же read-only C-source в overlay targeted 49/49 + 2/2 PASS.
Повторные полные прогоны: unit 61 suites / 942 PASS; integration 31 suites /
355 PASS. Штатный route verifier подтвердил точный состав обоих наборов.
JSON circular serialization error первой попытки был вторичен к ENOENT и
исчез после исправления стенда; исходники и тесты не менялись.

| Проверка | Повторный результат |
|---|---|
| Backend full unit, Linux ARM | 61 suites, 942/942 PASS |
| Backend full integration, PostgreSQL, Linux ARM | 31 suites, 355/355 PASS |
| Frontend full, macOS, Node 24 | 27 files, 325/325 PASS, без skips |
| Dependency runtime, Linux ARM и macOS Node 24 / контроль Node 20 | 7/7 PASS на каждом |
| Python CI tests из отслеживаемых файлов, без двух CLI helpers | 25 suites PASS |
| Hardening targeted (входят в Python результат выше) | 31 + 10 + 18 + 10 PASS |
| Backend/frontend lint и build, macOS Node 24 | exit 0; backend lint: прежние 20 warnings |
| Backend lint, tsc --noEmit, build, compiled file-type runtime, Linux ARM | PASS; lint: те же 20 warnings |

Полные локальные журналы и reports (временные файлы, не в Git):
`/tmp/homecloud-rca-arm-unit.log`, `/tmp/homecloud-rca-arm-integration.log`,
`/tmp/homecloud-rca-arm-targeted.log`, `/tmp/homecloud-rca-arm-probe.log`,
`/tmp/homecloud-rca-frontend.json`, `/tmp/homecloud-rca-python.log`,
`/tmp/homecloud-rca-arm-lint-build-security.log`; Linux unit/integration JSON
reports сохранены рядом с одноимёнными log.
Промежуточные ошибки сохранены в `*-attempt1.log` и
`/tmp/homecloud-rca-linux-targeted.{log,json}`; они не выдаются за PASS.

### Независимое заключение RCA

Отдельный reviewer, не участвовавший в исправлении окружения, независимо
проверил git tree equivalence, причины 38 FAIL, frontend JSON 325/325,
Linux unit/integration JSON 942/942 и 355/355 без skips и штатный route
verifier. Самостоятельно повторил dependency runtime 7/7 PASS. Blockers
в RCA и исправлении окружения не обнаружены.

**READY_FOR_PUSH** — локальные результаты достаточны для публикации изменений
в PR и запуска целевого CI. Подтверждённых регрессий hardening и оставшихся
FAIL в правильно подготовленных финальных прогонах нет. Это не разрешение на
push без согласования владельца, merge или deploy. Linux/amd64 CI, scanners
и эксплуатационные drills/provisioning ниже остаются отдельными проверками.

Из отслеживаемых файлов в этой задаче изменён только этот отчёт. Исправление
node_modules выполнено без изменения lockfile/исходников/тестов. Семь исходных
untracked-файлов не затрагивались. SSH/мини-ПК/deploy не использовались.

## Гарантии и границы

До остановки сервисов создаётся backup с независимой проверкой metadata,
SHA256, размеров, gzip, состава tar и inventory миграций. SQL восстанавливается
в отдельный PostgreSQL-контейнер без сети и host mounts. После остановки
пишущих сервисов создаётся и проверяется финальная копия. Предварительная
online-копия не считается согласованным снимком DB/storage.

Disposable PostgreSQL использует точный image ID настроенного закреплённого образа БД, tmpfs PGDATA
1 GiB, память 512 MiB, CPU/PID/time limits. Превышение лимитов блокирует
установку. Это проверка SQL restore и inventory, а не полный прикладной
disaster recovery drill. Storage проверяется без извлечения на рабочие диски.

Автовосстановление разрешено только до возможного запуска target: при
неизменных journal/schema/container identities возвращаются checkout и refs,
запускаются существующие прежние контейнеры, проверяется health. Данные не
перезаписываются. После возможного запуска target, несовместимости миграций,
ошибки recovery или неопределённости требуется `MANUAL_RECOVERY_REQUIRED`.
Pending остаётся даже после `ROLLED_BACK`; повторная установка запрещена до
ручной сверки. Power loss не запускает автоматическое восстановление.
`INSTALLED` публикуется только после проверок и durable удаления pending.

Root trust anchor описан в [test-root-boundary.md](test-root-boundary.md).
Небезопасные владельцы/права/ACL/ссылки каталогов, Git configuration и внешние
backup/Compose пути блокируют выполнение. Старые sudoers entrypoints нельзя
считать исправленными одним обновлением checkout: нужна отдельная установка
проверенного launcher и аудит разрешённых команд оператором.

## Исторические результаты первого локального запуска

- Installer: 31 тест PASS; SSH job: 10 PASS.
- Root boundary: 18 PASS; backup qualification: 10 PASS.
- Admission: 5 PASS; fast CI gate: 3 PASS; candidate gate: 4 PASS.
- Backup dump structure: PASS; shell syntax и git diff --check: PASS.
- Остальные 21 Python test suite из scripts/ci: PASS. Два CLI helper,
  ошибочно включённые общим glob в первом запуске, вернули usage; они не tests.
- Backend updates targeted: 4 suite, 20 тестов PASS.
- Полный backend unit route: 57 suite PASS, 4 FAIL; 904 теста PASS, 38 FAIL.
  Ошибки в upload-rate-limit, upload-workspace, ingress-file-cleanup и
  secure-filesystem; native filesystem требует Linux. Первый запуск ограничен
  listen EPERM; повтор с доступом к локальным портам дал указанные результаты.
  После результатов Jest не завершился из-за открытых ресурсов и был остановлен.
- Frontend: 26 suite PASS, 1 FAIL; 324 теста PASS, 1 FAIL в PublicUploadPanel
  (отсутствует ожидаемый expectedSha256). Эти файлы не менялись в задаче.
- Backend и frontend lint: exit 0 (backend: 20 warnings); обе сборки: exit 0.
- Dependency security runtime: FAIL. Nest/direct Multer не совпадают;
  malformed multipart вызывает Invalid array length; suite завершился timeout.
  Локальные node_modules не переустанавливались. Общая безопасность зависимостей
  этим запуском не подтверждена.

## Обязательно проверить отдельно на Linux

Независимый security review выполнен отдельным агентом, не участвовавшим в
реализации. Найденные P1 (backup paths до root execution) и P2 (startup gate
в operational contract, fail-closed ошибки обхода дерева) исправлены и
перепроверены; открытых P1/P2 в просмотренном diff не осталось. Reviewer
самостоятельно получил 31/10/17/10 PASS; после добавления отдельного onerror
теста основной исполнитель получил 18 root-boundary PASS. Это ограниченное
заключение по коду и локальным тестам, не разрешение на эксплуатацию.

В конечном linux/amd64 CI остаётся повторить установку закреплённых
зависимостей, сборку native module, полные unit/integration suites с PostgreSQL
и dependency runtime: локальный Linux ARM прогон не заменяет целевую
архитектуру CI. Также остаются сканеры CI. Trivy/Gitleaks локально отсутствуют;
image/secret scans не выполнялись.
Прежний успешный CI не подтверждает новые локальные commits.

В изолированном Linux-стенде проверить настоящие Docker/Compose stop/start,
оба backup и disposable SQL restore (включая лимиты и cleanup), health failure,
неуспешный rollback, SIGKILL/reboot на каждой фазе, fsync на реальной файловой
системе, запрет повторного запуска, подмену executable/dependency, ACL и Git
config. Проверить root-owned launcher, все ancestors (включая /home/hs),
sudoers, Docker config/plugins и системные binaries. При user-owned /home/hs
установщик намеренно блокируется; автоматического chown нет.

Мини-ПК не изменялся. SSH, deploy, push и merge не выполнялись.
Compose architecture и данные сохранены; backend без Docker socket,
`UPDATE_INSTALL_BRIDGE_ENABLED=false`.
