# Локальная квалификация security hardening PR #18

Исходная ветка: `тестовый-канал-обновлений`, исходный commit
`0720e8c4e390edc74a3f2c854de16f4899b11883`. Изменения не опубликованы.

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

## Фактически выполненные локальные проверки

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

Нужны чистая установка закреплённых зависимостей и Linux native module,
полные unit/integration suites с PostgreSQL, dependency runtime и сканеры CI.
Trivy/Gitleaks локально отсутствуют; image/secret scans не выполнялись.
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
