# SSD→HDD: отчёт этапа 1, 2026-10-12

Проверенная исходная база: `4ba373275baf98344596176658c5ae54a3ca4b0b`.
Коммиты реализации:
- `320cf1372dbd24b7a3073aa4800c40c359dddfb9` — identity/migration/совместимость.
- `538e9f37e665348a014fb76c967be938a719c853` — Registry/Workspace/проверки.

## Результат и границы

Подготовлены reserved SSD Upload Workspace, opt-in trusted mount binding и
отдельная prepared descriptor capability. Решение владельца: обычные загрузки
остаются legacy до согласования этапа 2. SSD не добавлен в постоянные File storage
locations. `STORAGE_PATH`/legacy storage остаётся единственным источником download.
Само приложение не определяет, является ли legacy носитель физическим HDD.

Изменены только три существующих backend файла: workspace identity constants,
StorageMountRegistry и StorageService. Добавлены binding parser, подготовленный
SSD workspace, одна миграция и три suite. Admission, Multer routing,
legacy workspace resolver, complete, recovery и File placement код не изменены.
Модель — доверенный личный сервер; attestation research не продолжается.

## Миграция

`1746825170000-PrepareSsdUploadWorkspace` транзакционно вставляет одну identity.
Не изменяет прежние SQL guards, paths, sessions, files, chunks, quota или shares.
Реальная PostgreSQL-проверка использовала все 22 прежние миграции, затем новый
up/down, fixtures legacy file/chunk/session/user, проверки конфликтов UUID и
обоих ключей, immutability и запрет SSD session/File placement. Production
миграция не запускалась; writer fence при deployment обязателен.

Независимый reviewer обнаружил неверную обработку результата DELETE RETURNING
в `down`. Исправлено на CTE + SELECT; повторный PostgreSQL rollback test PASS.
По итоговому focused review других blockers нет.

## Проверки

- Targeted: 5 suite / 55 tests PASS, включая 5 новых PostgreSQL тестов.
- Полный candidate backend: 66 suite PASS / 6 FAIL; 879 tests PASS / 71 FAIL.
- Исходный HEAD: 63 suite PASS / 6 FAIL; 861 tests PASS / 71 FAIL.
- Статусы всех 932 исходных tests совпадают: новых регрессий в выполненном наборе
  не выявлено. Добавлены 18 PASS; полный набор остаётся красным.
- Шесть FAIL suite используют действующий Linux-only upload filesystem путь;
  на macOS он возвращает `Secure upload filesystem requires Linux`, включая
  последующие ошибки upload admission/HTTP. Linux-native выполнение не заявлено.
- Lint: 0 errors / 15 прежних warnings. Build и TypeScript noEmit PASS.
- `git diff --check` выполнен перед commit.

[Машиночитаемые результаты и ограничения](checks.json).
Raw test logs сохранены в локальном `/private/tmp/homecloud-stage1-20261012/`.
Тесты выполнены в отдельной копии backend с временными fixtures и одноразовой
PostgreSQL 15, Unix socket only, без TCP listener, Docker/VM и live данных.
Полный candidate Jest удерживался прежними timers после записи результата;
завершён только этот тестовый процесс. Для baseline применён forceExit после
получения результата. Тестовая БД остановлена после проверок.

## RAM, совместимость и оставшиеся риски

Новые операции не читают пользовательские files и не добавляют file buffers,
worker/очередь или параллельные операции переноса. SSD marker читается ограниченным
1025-byte buffer; число новых registry bindings/FD anchors фиксировано.
Действующие chunk limits, streaming/backpressure и rate admission сохранены.
Это не измерение RSS на файле 50+ ГБ: RAM-квалификация и ограничение параллельности
будущего finalizer требуют этапа 2 и отдельно разрешённых испытаний.

Mountinfo проверки используют fixtures; PreparedSsdWorkspace native boundary
в portable contract тесте подменена. Реальные SSD/HDD, mount loss/remount,
Linux descriptor boundary и power loss здесь не квалифицированы. Правильный host
FS UUID и container bind mapping проверяются оператором, marker не копируется
на другие диски. Криптографического доказательства физического носителя нет.

Сохранены прежние UUID, paths, metadata и API режим; недоступный optional SSD
не переключает обычный API на fallback directory. Partial SSD config вызывает
отказ constructor, полный config ещё не активирует SSD uploads. Все существующие
untracked файлы сохранены. Запрещённый audit файл не читался, не искался,
не хешировался и не изменялся.

Статус COMPLETE не установлен. Production NOT_READY / NO_GO сохраняется.
После этого отчёта работа остановлена; cross-FS finalizer, recovery, перенос
данных, deploy и физические 50 GiB испытания требуют отдельного согласования.
