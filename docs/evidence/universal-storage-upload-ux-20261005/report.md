# Universal Storage & Upload UX — приёмка 5 октября 2026

`UNIVERSAL_STORAGE_UPLOAD_UX_STATUS = PASS`.
`50_GIB_BROWSER_E2E_STATUS = FAIL / REQUALIFICATION_REQUIRED`. Полный50GiB Browser E2E не запускался. Максимальный реальный browser fixture —128MiB. Набор backend использует4GiB+17 sparse Rangefixture вместо прежнего50GiB файла; метаданные synthetic50GiB не являются Browser E2E.

## INITIAL_STATE

`main`, HEAD `9fc738463e344599b2dcb6d54aa0776bf3f052fe`, ahead/behind `11/0`. Предыдущий rate-limit checkpoint PASS. Три исходных untracked-файла сохранены; запрещённый audit не читался. Разрешение на новые файлы реализации/тестов/evidence получено отдельно.

## CAPABILITY_MATRIX_BEFORE

[Все исходные возможности с классификацией и точными ссылками на код](audit-before.md). Аудит выполнен до редактирования. Работавшие cancel, quota/TTL и Retry-After сохранены. Добавлены отсутствовавшие batch, file DnD, Pause/Resume/reselection и публичная сверка сессий.

## BIN_ROOT_CAUSE

Финализация сравнивала определённый по содержимому MIME со стандартным allowlist, не содержащим application/octet-stream. Байты и чанки принимались, затем complete отклонял бинарное содержимое. Расширение .bin само по себе не было запретом. Удалена именно admission-проверка MIME; detector оставлен для metadata/preview с безопасным fallback.

## UNIVERSAL_FILE_POLICY

Нет allowlist расширений/MIME для хранения. Неизвестное содержимое, octet-stream и несовпадение расширения/MIME допустимы. Логическое имя, регистр/Unicode расширения и байты сохраняются. Длинное допустимое имя использует ограниченное внутреннее имя на диске. Безопасные Content-Disposition/filename*, traversal/filename validity, auth/ownership, quota, size/chunk limits и integrity сохранены. 1TiB/file — конфигурируемый инфраструктурный предел MAX_FILE_SIZE. Неподдерживаемый preview не запрещает upload/download.

## FILE_TYPE_RUNTIME_MATRIX

[Реальные типы, размеры, MIME и SHA-256](file-type-runtime-matrix.md), [34сохранённых файла до очистки](runtime-before-cleanup.json), [хеши скачиваний](download-hashes.json). BIN, EXE,7z, ISO, DMG, APK, ZIP, unknown/no-extension, misleading .jpg, текст и PNG прошли. Пустой файл явно пока не поддерживается; его ошибка изолирована.

## BATCH_UPLOAD

Picker multiple без accept. Каждый файл имеет своё состояние/прогресс/ошибку/Pause/Resume/Cancel. Очередь ограничена двумя файлами × одним chunk на файл; slice не читает целый большой файл. Реальный пакет9файлов:8успехов и1ожидаемая ошибка пустого файла. Серверные quota/session ошибки отображаются на соответствующем элементе; focused tests проверяют isolation и bounded scheduling.

## DRAG_DROP

Один/несколько файлов добавляются в ту же очередь в текущую папку; browser navigation предотвращена, доступная подсветка предусмотрена. Реальный межоконный перенос выполнен владельцем, затем агент проверил UI, folder target и хеши. IAB: два файла в folderId2; Safari: два файла в корень. [IAB](iab-drop-completed.jpg), [Safari](safari-drop-completed.png). Подсветка проверена кодом/автотестами; screenshot момента drag не снят. Перетаскивание папок — явно будущая возможность после аудита directory-entry API, в текущем scope не реализовано.

## UPLOAD_STATE_MACHINE

selected → queued → preparing → uploading/retrying → completing → completed; pausing/paused, error, needs-file, cancelling/cancelled. In-flight chunk завершается безопасно; новые чанки/таймеры остановлены при Pause. Потерянные create/complete ACK сверяются с сервером; completed не отменяется как pending. Независимый review принят.

## PAUSE

Pause не вызывает DELETE, не освобождает reservation и не удаляет chunks. Первоначальный IAB-прогон:30MiB/3chunks оставались неизменными в двух чтениях БД с интервалом5с. Safari повторный доказанный прогон:20MiB перед pausing, затем30MiB/23% paused после завершения текущего chunk. [Safari paused](safari-paused.png).

## RESUME_SAME_PAGE

IAB: uploadId `eaa75c24-60b0-4887-8726-2791008121e9`, pause после3принятых chunks, Resume той же session, hash готового128MiB совпал. В первоначальном наблюдении после GETmanifest прошли10оставшихся chunks и complete200. Повтор после контролируемого429 также использовал прежнюю session. Алгоритм сверяет committed chunks/hash и пропускает их.

## NETWORK_INTERRUPTION_RESUME

Первый IAB runtime: остановка backend вызвала сбой финализации при уже принятых13chunks; UI сохранял99%, затем reselect/reconcile завершили прежнюю session `e193acb0-0960-479e-972b-726d32a4bf6d`.

Дополнительная точечная HTTP503 инъекция на chunk-route только собственного uploadId `da4dff0d-6ec9-43bf-abc7-4027b432b27b`:3неудачные попытки, UI «Прогресс сохранён»,4chunks/40MiB оставались на сервере. [До Resume](network-retained.json), [UI](iab-network-error.jpg), [503ответы](503-proxy.log). После восстановления исходного Nginx явный Resume завершил тот же uploadId, итоговый SHA-256 a626… совпал. Это управляемый сбой HTTP, не симуляция глобального offline браузера.

## RELOAD_RESUME

Первоначальный IAB: reload → needs-file при30MiB; reselect → прежний uploadId `21f8a72f-d8c1-4508-9679-8ab110eb21a6`, полный hash совпал.

Safari повторный прогон: uploadId `cb59c548-e04e-4a49-9228-fd9bd2ace419`, paused30MiB/23% → reload → needs-file30MiB/23% → системный picker исходного файла → та же session completed13chunks/128MiB. [Запрос выбора файла](safari-reselect.png), [Итог](safari-resume-result.json), [UI100%](safari-resumed.png).

## BROWSER_RESELECTION_MODEL

Метаданные localStorage разделены по owner; содержат session/name/size/parent/accepted progress/fingerprint/notBefore/cancel intent. Не содержат rawbytes/JWT/пароли. Обычный File нельзя автоматически вернуть после reload; пользователь выбирает исходный файл. Проверяются имя/размер, выборка до3×64KiB при наличии и SHA-256 каждой принятой части. Выборка не гарантирует идентичность ещё не переданных байтов вне неё. WebCrypto требует HTTPS/localhost. File System Access enhancement не внедрён; обычный Safari fallback реально проверен. Полное закрытие/перезапуск браузера отдельно не квалифицировано; reload — обязательный минимум выполнен.

## CANCEL

Отдельный DELETE с подтверждением cleanup; не затрагивает соседей. Failed cancel сохраняет намерение и возможность повторить. В случае потерянного успешного complete ACK reconcile восстанавливает completed. После подтверждённого abort committedBytes обнуляется. Повторный IAB `ux-cancel-check.bin`, uploadId `11faaf2f-824e-4f81-b3d0-bfb9161d7f3b`: aborted,0chunks,tempExists=false и UI0bytes/0%. [UI](iab-cancel-zero.jpg).

## PROGRESS_SEMANTICS

Показывается принятый сервером объём.100% только после finalization/reconcile completed; до того максимум99%. Pausing ещё ждёт in-flight ACK. Pause/retry/reload не теряют принятую часть. Confirmed cancel показывает0durablebytes после удаления, а aggregate исключает этот объём. Canonical formatBytes сохранён.

## RATE_LIMIT_INTEGRATION

Backend transfer limiter сохранён:25req/s burst50/user,4parallel/user и32/process; отдельный abort budget. Frontend максимум2chunk requests. Retry-After ограничен60с/ожидание,3attempts,5min окно; pause останавливает timer, notBefore сохраняется.

Точечная runtime инъекция HTTP429 с Retry-After30с в Nginx затрагивала только chunk-route тестовой session `7e17b3ea-fce0-492f-b4e7-3b710b2099de`. [Один429](429-proxy.log), [Retry UI](iab-429-retry.jpg). При30MiB UI retrying → Pause → paused → исходный Nginx восстановлен → Resume → completed/hash. Это проверка клиентского взаимодействия с429 через proxy; естественное исчерпание backend limiter проверено HTTP/PostgreSQL regressions, включая5120synthetic chunks. Backend лимиты не менялись для этого теста.

## REAL_UI_BIN_HASH

Source/stored/download262144bytes: `2312394bd99545d9de131c24efb781e765ac1aec243f2ed9347597a793a415e9`. Native UI download выполнен в IAB и Safari. Дополнительно unknown589bytes, no-extension768bytes и128MiB download совпали: [скачивания](download-hashes.json).

## REAL_UI_BATCH

IAB два прогона по9mixedfiles:8success+emptyerror, включая произвольные бинарные расширения, unknown/no-extension и text/image. [Повторный пакет](iab-batch-types.jpg). Safari системный picker:5mixedfiles успешно, stored hashes в snapshot для QA user4.

## REAL_UI_DRAG_DROP

PASS: IAB2files→folder2; Safari2files→root. Перенос сделал пользователь («перетащил»), агент проверил completed/UI/parentId/точные bytes+hash. Keyboard/picker работали через настоящие системные диалоги и IAB chooser.

## REAL_UI_PAUSE_RESUME

PASS: IAB128MiB same-page session+hash; Safari paused30MiB true; pause во время429retry → resume той же session completed/hash.

## REAL_UI_RELOAD_RESUME

PASS: IAB и Safari. Safari сохранял30MiB/23% через reload и запросил оригинальный файл; reselect завершил прежний uploadId. Новую session для этого файла не создавали.

## REAL_UI_CANCEL_ISOLATION

Первоначальный IAB batch двух128MiB: `14d68f9d-fa4d-4107-a874-4abd5ae5b61e` отменён, chunks0/tempfalse; сосед `dbb047ce-2c32-4aa9-aa58-553876cd871a` завершил128MiB с SHAa626… . Повторно проверено обнуление cancelled bytes в последнем frontend build. Серверный снимок сохраняет обе первоначальные terminal sessions до адресной cleanup.

## SAFARI_RESULT

PASS требуемых отличающихся browser flows: обычный login нового QA account, native multiple picker5files, BINdownload/hash, native fileDnD2files, Pause/reload/reselection/same-session resume128MiB/hash. Пароли не сохранялись в Safari. Владелец первоначально ошибочно назвал вторую IAB-вкладку Safari; она не засчитана как Safari evidence. Полноценная Safari приёмка выполнена отдельно.

## CHROMIUM_IAB_RESULT

PASS в Codex IAB: arbitrary storage/download,9filebatch with isolated failure, native fileDnDcurrentfolder, pause/resume, reload/reselect, controlled503 retry exhaustion/resume, cancel isolation/zero progress, controlled429+Pause/Resume. Внешний Chrome не был доступен; проверен основной IAB.

## CLEANUP

Адресно через существующий FilesService удалены34QAfiles и1папка, затем36terminal QA sessions и два созданных Safari QA accounts4/5. [Точный план](cleanup-plan.json), [итог](cleanup-result.json). Оригинальная used quota37021bytes; active reserve0; chunks0; tempfiles0; собственные физические файлы user4/5 —0bytes; disposable testDB0. В .tmp осталась пустая штатная директория multipart-ingress. Собственные QA helpers и точечные proxy rules удалены, исходный Nginx восстановлен. Fixtures, одноразовый password и5проверенных download copies удалены. Предыдущий /private/tmp каталог исчез во время внешнего прерывания; он не считается сохранённым evidence.

## BACKEND_TESTS

Последний полный набор:63suites825/825PASS0skips. Focused138/138PASS. [Полный лог](backend-full.log), [focused](backend-focused.log). В ранних полных прогонах один раз падали существующие trusted-proxy/observability tests; точная причина не установлена. Targeted повтор и два финальных полных прогона825/825 прошли; эти ранние отказы не выдаются за исправленный дефект.

## POSTGRES_INTEGRATION

Все7реальных PostgreSQL suites:68/68PASS0skips. Каждый прогон использовал новую disposable DB в существующем PostgreSQL контейнере; preview DB тестами не использовалась. Собственная DB удалена finally. [Лог](backend-postgres.log), [сводка](backend-summary.json).

## FRONTEND_TESTS

19suites218/218PASS на финальной реализации, focused49/49 послеcancelprogressfix. [Восстановленный полный лог](frontend-gates.log). Новый тест failedcancel → restore → confirmedcancel проверяет сохранённый до ACK и нулевой после ACK прогресс.

## LINT_TYPECHECK_BUILD

PASS backend/frontend lint, typecheck, production builds, backend benchcompile и compiled CommonJS file-type loader. Backend lint:0errors,15существовавших Jest warnings; frontend0warnings. git diff --check PASS. Повторные проверки выполнены после потери временных логов; лог сохранён в постоянный project catalog.

## STORAGE_SECURITY_REVIEW

ACCEPT, нерешённых CRITICAL/HIGH0. [Независимое заключение](storage-security-review.md), проверенная реализация HEAD8818f92. Path/filename/header/auth/owner/quota/integrity границы сохранены.

## RESUME_CORRECTNESS_REVIEW

ACCEPT, нерешённых CRITICAL/HIGH0. [Независимое заключение](resume-correctness-review.md): pause/retry/lostACK/reload/auth generation/concurrency/reservation/cancel проверены. Review выполнен независимо от автора.

## DOCS_UPDATE

Обновлены README(product+architecture), operations-runbook, frontend-functional-acceptance и ROADMAP. Универсальное хранение, preview separation, batch/DnD, state semantics, reload/reselect/browser limits, quota/configurable limits и известный TLS/private-tmp concern зафиксированы. Новая numbered Phase не создана.

## COMMITS

- `6b084bbc63baed430fd58cd2ea7689920682ee15` — Разрешить хранение произвольных файлов и сверку загрузок.
- `2fd0bb4934f129949018efa67300bf3faeafaedf` — Добавить очередь загрузок с паузой и восстановлением.
- `8818f92a63281d23d062f1001c94e719ab98933b` — Обнулить прогресс подтверждённой отмены загрузки.
- Финальный отдельный commit документации и доказательств указан в итоговом ответе; он содержит этот отчёт.

## FINAL_HEAD

Проверенный код: `8818f92a63281d23d062f1001c94e719ab98933b`. Финальная вершина после коммита этого отчёта указана в итоговом ответе; включить hash содержащего её коммита внутрь того же файла невозможно без изменения hash.

## GIT_STATUS

После адресного добавления документации/evidence должны остаться ровно3исходных untracked; итог проверяется после commit. Никаких push/tag/historyrewrite/squash. Запрещённый audit не читался/не менялся/не добавлялся.

## UNIVERSAL_STORAGE_UPLOAD_UX_STATUS

PASS: arbitrary binary storage и обязательные batch/fileDnD/Pause/Resume/Cancel UI доступны и runtime проверены в IAB/Safari. Нерешённых CRITICAL/HIGH нет.

## 50_GIB_BROWSER_E2E_STATUS

FAIL / REQUALIFICATION_REQUIRED. Здесь не запускался и не переквалифицирован.

## REMAINING_GAPS

Пустые файлы и folder DnD пока не поддерживаются. Автоматический reacquire файловых handles и pagination discovery свыше200server-only sessions не реализованы. Browser restart отдельно не квалифицирован; reload minimum выполнен. Fingerprint выборки не является полным хешем ещё не переданных байтов. WebCrypto требует secure context. Production deployment NO_GO не отменён: TLS certificate/key зависят от /private/tmp, каталог исчез после прерывания и ingress теперь перезапускается из-за отсутствующих временных материалов; TLS в этом scope не меняли.

## NEXT_STEP

После PASS остановиться. Следующий отдельно разрешённый checkpoint — финальная50GiB Browser E2E requalification на готовом upload UX. Перед deployment нужно устранить зависимость TLS certificate/key от очищаемого временного каталога и пройти оставшиеся deployment gates.

## Границы доказательств

Межоконный DnD выполнен человеком с последующей проверкой, не синтетическим событием. Журналы первоначальных IAB/Safari тестов в /private/tmp исчезли после внешнего прерывания; описание тех наблюдений сохранено из журнала задачи, а актуальные hashes/sessions повторно прочитаны из БД перед cleanup. Ключевые сценарии reload/Safari,429,partialfailure,resume,cancelzero,batchtypes,DnD подтверждены новыми постоянными screenshots/JSON. Позднее извлечение request counters из Nginx не дало событий для выбранных uploadId; пустые counters не считаются доказательством. Пропуск уже принятых частей подтверждён первоначальным наблюдением IAB, кодом и focused regression tests; новые Safari/503 прогоны подтверждают сохранение принятого прогресса, прежний uploadId и точный итоговый hash. Сырые логи браузера, JWT и пароли в evidence не включены.
