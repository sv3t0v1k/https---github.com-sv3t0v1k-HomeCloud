# Функциональная приёмка интерфейса HomeCloud

Дата: 2026-10-02, Asia/Vladivostok. Ненумерованный аудит по прямому запросу владельца. Статические контракты, unit/component tests и реальные браузерные действия учитываются отдельно. Наличие компонента или passing test не означает runtime PASS. Итог ограничен перечисленными ниже доказательствами; исчерпывающая приёмка остаётся INCONCLUSIVE.

## INITIAL_STATE

На старте проверены main, HEAD `ff036da6d771f639aedc6bfd052946513d4f4eff`, ahead/behind 0/0; единственный прежний untracked файл — запрещённый audit. Запрещённый audit не читался и не изменялся. `sources/` не изменялись. Чужие старые контейнеры не использовались. Общая production readiness сохраняется NOT_READY.

## BACKEND_UI_CAPABILITY_MATRIX

Источники: `backend/src/{auth,users,files,uploads,previews,sharing}/*.controller.ts`, соответствующие services; `frontend/src/App.tsx`, API clients и компоненты. Все пути ниже относительно repository root.

| Возможность | Backend contract | UI / классификация |
|---|---|---|
| Login / refresh / logout | POST auth/login, auth/refresh, auth/logout | UI_PRESENT: login, восстановление сессии, выход |
| Регистрация | POST auth/register | DEFERRED_BY_PRODUCT_DECISION: ROADMAP:387 |
| Чтение профиля | GET users/me | UI_PRESENT: sidebar, session bootstrap |
| Изменение профиля / пароль | PATCH users/me; POST auth/change-password | Ранее UI_MISSING; добавлен AccountDialog, runtime профиль проверен; пароль NOT_EXECUTED |
| Квота / usage / counts | GET files/storage-info | Ранее UI_MISSING; AccountDialog, runtime отображение проверено |
| List / folder detail | GET files, files/folders, files/folders/:id | UI_PRESENT: root/nested browser, breadcrumbs |
| Create / rename | POST files/folders; PATCH files/:id, files/folders/:id | UI_PRESENT |
| Move file / folder | POST files/:id/move; PATCH files/folders/:id parentId | UI_PRESENT; исправлен выбор папок вне текущего уровня |
| Copy file | POST files/:id/copy | UI_PRESENT; copy в соседнюю и вложенную папки подтверждён с сохранением на сервере |
| Copy folder | Recursive endpoint отсутствует | NOT_APPLICABLE, UI не обещает операцию |
| Upload | POST uploads/session, chunk, complete; DELETE session/:id | UI_PRESENT; текст/image runtime проверены |
| Upload reload resume | GET uploads/sessions возвращает pending | DEFERRED_BY_PRODUCT_DECISION: ROADMAP:336 |
| Download | GET files/:id/download, Range | UI_PRESENT; 100 MiB Blob limit намеренный (ROADMAP:335); browser byte proof PENDING |
| Preview | GET previews/:id | UI_PRESENT text/image; unsupported state; backend 5 MiB boundary |
| Thumbnail | GET previews/:id/thumbnail | UI_MISSING auxiliary presentation, новая thumbnail UI не добавлена |
| Trash / restore / permanent / empty | files/trash, restore, permanent, empty-trash | UI_PRESENT; delete/restore/permanent/empty подтверждены на одноразовых данных |
| Owner sharing | POST/GET sharing; DELETE sharing/:id | UI_PRESENT create/list/revoke/password/expiry/download limit |
| Public sharing | public/:token, verify, download, children | Ранее JSON вместо recipient UI; добавлен /share/:token; runtime create/password/download/revoke/expiry подтверждён |
| Search | files/search?q; files?search | DEFERRED_BY_PRODUCT_DECISION: ROADMAP:566; реальный ILIKE backend |
| Pagination owner listing | Backend contract отсутствует | DEFERRED / NOT_APPLICABLE: ROADMAP:422 |
| Public-folder pagination | children limit/offset/hasMore | Новая public UI; 51 папка, next/previous и breadcrumbs проверены |
| Selectable sort/filter | Backend fixed ordering; search отдельно | NOT_APPLICABLE для selectable сортировки; list/grid client-only |
| Health/live/ready, metrics | Health routes; dedicated metrics bearer | INTERNAL_NOT_FOR_UI |
| Account deletion/admin/session inventory | Endpoints не найдены | NOT_APPLICABLE |

Исторические документы противоречивы по public sharing: ROADMAP:487/495 включает public flows, :566 сохраняет anonymous sharing limitation. Новый recipient UI исправляет фактическую непригодность ссылки; документ не выдаёт прежнюю JSON страницу за работающий пользовательский flow.

Имена папок могут совпадать: createFolder проверяет непустое имя и ownership, schema не имеет sibling-name UNIQUE. Это текущий backend contract; duplicate acceptance не объявляется frontend FAIL. Доказанного отдельного product rationale нет.

## FRONTEND_SURFACE_INVENTORY / INTERACTIVE_CONTROL_AUDIT

Индекс выполненных действий ниже. Он не заменяет исчерпывающий поконтрольный протокол.

| Surface / controls | Ожидаемое действие | Runtime evidence / статус |
|---|---|---|
| Login email/password/submit/Enter | login, error, protected redirect | valid/invalid/Enter проверены |
| Navbar logout | revoke refresh + local termination | Выход и повторный вход проверены |
| Navbar account / close | modal; quota/profile/password | open/quota/profile notice проверены; password NOT_EXECUTED |
| Sidebar files/trash | route navigation | Переходы files/trash проверены |
| Mobile drawer open/close/overlay/Escape/nav | navigation + focus lifecycle | Открытие, навигация и Escape проверены; полная матрица не квалифицирована |
| Files breadcrumbs, folder row/card, Back/Forward | URL и содержимое согласованы | root/nested/breadcrumbs/Back/Forward/reload проверены |
| List/grid toggles | view state | Открытие, навигация и Escape проверены; полная матрица не квалифицирована |
| Create folder save/cancel | POST или no side effect | create/duplicate contract/empty validation/cancel проверены |
| File/folder overflow menus | preview/download/share/rename/move/copy/trash | частичная проверка; все entries не объявляются PASS |
| Rename save/cancel/close | PATCH, validation | empty validation и Cyrillic post-fix проверены |
| Move/copy destination select/retry/submit/cancel | server mutation; folders outside current level | sibling move/copy/nested copy проверены; subtree исключён; полный error coverage не квалифицирован |
| Upload picker/start/cancel/retry/manager | upload lifecycle | text/image/progress/cancel/reselection проверены; retry fault и multiple не квалифицированы |
| Preview close/Escape | preview; focus return | image/text, Escape/focus и oversized error проверены; полный unsupported coverage не квалифицирован |
| Share create/copy/open/revoke/close | owner lifecycle | create/clipboard/revoke/public/password/expiry проверены |
| Trash restore/permanent/empty confirmations | server mutation | soft delete/cancel/restore/permanent/empty и disabled empty проверены |
| Public password/open/download/folder/breadcrumb/pages/retry | anonymous recipient lifecycle | password/children/download/breadcrumbs/pages/expiry проверены; полный retry coverage не квалифицирован |
| Unknown route link | meaningful fallback /files | fallback и переход к файлам проверены |

Неуказанные icon labels, enabled/disabled conditions и отдельные действия требуют итогового raw browser inventory. Этот сокращённый индекс не является утверждением проверки каждого control.

## AUTH_ACCEPTANCE

Runtime PASS: гостевой redirect, invalid/valid login, Enter, session restore, logout/relogin. Полная forced-expiry матрица не выполнена.

## NAVIGATION_ACCEPTANCE

Runtime PASS: root/nested, breadcrumbs, Back/Forward, direct nested reload. Не заявляется исчерпывающая race qualification.

## FILE_OPERATIONS_ACCEPTANCE

Runtime PASS: создание, duplicate-permitted contract, empty rename validation, точное Cyrillic имя после fix, folder rename/move, file move sibling и copy into nested folder id3; breadcrumbs к родителям и reload. Мутации проверены по persisted API state. Все cycle/stale/double-submit комбинации не заявляются.

## UPLOAD_ACCEPTANCE

Runtime: image/text success, повторный выбор того же файла; 110 MiB upload наблюдался на27% и завершён; повтор немедленно отменён с canceled state. Первый cancel click был слишком поздним, завершение нормально и не объявлено дефектом. Text FAIL до MIME fix воспроизведён, после fix PASS. Ошибка квоты реально наблюдалась при нулевой квоте. Retry после recoverable upload fault, forced413 и множество файлов не проверены.

## DOWNLOAD_ACCEPTANCE

Public file и ZIP показывают подготовку скачивания; owner large-file action даёт понятную Russian 100 MiB guard error. HTTP SHA-256 трёх fixtures совпал с исходными bytes, см. `api-evidence.json`. Browser download event capture timeout: exact saved browser output bytes UNVERIFIED. HTTP proof не подменяет browser-byte acceptance; DOWNLOAD_UI не получает полный PASS.

## PREVIEW_ACCEPTANCE

Text/image preview, Escape/focus return подтверждены. Oversized preview показывает ошибку. Все unsupported/loading/abort combinations не проверены.

## SHARING_ACCEPTANCE

Owner create/list/clipboard/revoke; password wrong/right, write-only input очищен; public file download prepared, public folder children + ZIP prepared; после revoke recipient показывает unavailable. Password link maxDownloads2 исчерпан: count2/2; revoked recipient unavailable подтверждён в правильной owner tab. Первые cross-tab stale actions не объявлены дефектом. Public expiry после безопасного изменения тестового срока подтверждён. Pagination проверена на 51 папке: 50 элементов, следующая страница с одним, возврат и breadcrumbs. Сохранённые browser bytes ZIP/file не подтверждены.

## TRASH_ACCEPTANCE

Runtime PASS: file/folder soft-delete, cancel, restore (дети папки сохранены), permanent-file/permanent-folder, empty-trash cancel/confirm; empty disabled semantics. Действия выполнялись на disposable данных.

## RESPONSIVE_FUNCTIONALITY

1440/1024/768/390/375: horizontal overflow отсутствует в проверенных views. 390 drawer focus trap/Escape; 375 account scroll. Исчерпывающий click inventory всех controls на каждой ширине не заявляется.

## ERROR_STATE_ACCEPTANCE

Invalid login и empty rename; чужая owner folder возвращает404 и скрывает существование, actual403 не индуцировался; UI показывает Russian missing-folder recovery; unknown route recovery. Backend stop вызвал502 create-folder error, restart/retry успешен без дубликата. Forced409/413, полный500/abort/error coverage NOT_EXECUTED.

## CONSOLE_NETWORK_REVIEW

Наблюдавшиеся dev console error/warn arrays пусты. Контролируемые401/404/502 ожидаемы. Исчерпывающий production CSP/network/secret logging audit не заменяется отсутствием ошибок в этих views.

## DEFECTS_FOUND / REMEDIATION

| Дефект | Минимальное исправление | Проверка |
|---|---|---|
| Null имя принималось optional DTO и вызывало внутреннюю ошибку | Проверка типа перед trim | Backend regression PASS |
| Физическое переименование портило/меняло отображаемые имена | Immutable storagePath; валидированное display name отдельно от generated path | Targeted backend + Cyrillic runtime |
| Unsigned UTF-8 text отклонялся как octet-stream | Весь файл проходит fatal UTF-8 streaming decoder; controls rejected; allowlist сохранён | Targeted tests + real text upload/preview |
| Move/copy picker ограничивался текущими детьми | Загружает дерево owner folders; исключает subtree moved folder | Targeted + sibling move |
| Повторный выбор того же upload не генерировал change | Reset input after successful upload | Targeted; повторный выбор в runtime подтверждён |
| Public link открывал metadata JSON | Recipient route + password/children/download UI | Targeted; recipient lifecycle в runtime подтверждён |
| Account/profile/quota end-user endpoints без UI | AccountDialog + actual API; session user update without bootstrap | Focused + profile/quota runtime |
| Неизвестный route давал пустую страницу | Explicit fallback with files link | Runtime fallback/переход подтверждены |

Независимый review выявил public async route lifecycle и account bootstrap/close проблемы; исправления повторно проверены reviewer по текущему diff; code APPROVE. Ограниченные исправления без redesign и новой Phase.

## FOCUSED_TESTS / FULL_FRONTEND_GATE

Frontend full130/130, lint и TypeScript/production build PASS. Account/session focused7/7 PASS. Backend files focused108, uploads59, независимый combined files/uploads122/122 PASS — это пересекающиеся группы, суммы не складываются. Полный backend с реальным одноразовым PostgreSQL: 59/59 suites, 725/725 PASS, 0 skipped, включая окончательный null regression. Backend lint PASS с15 прежними warnings. Backend build и git diff --check PASS.

## BROWSER_RUNTIME_EVIDENCE

Изолированный runtime root: `/private/tmp/homecloud-functional-ff036da`. HTTP byte proof: `/private/tmp/homecloud-functional-ff036da/api-evidence.json`; копия sanitized данных включена в `frontend-functional-evidence.json`. Основной browser operator сообщил перечисленные runtime outcomes. Это итоговый индекс результатов, не покадровый browser transcript. Credentials не включены в evidence и Git. Browser saved-file proof отсутствует из-за capture timeout.

## INDEPENDENT_REVIEW

Independent code review: APPROVE после bounded corrections (naming/UTF8, public async lifecycle, account session/modal). Functional reviewer: REJECT из-за неполного доказательства всех required flows. Code approval и functional acceptance различаются.

## DOCS_UPDATE / COMMITS / FINAL_HEAD / GIT_STATUS

Обновлены ненумерованный acceptance document и sanitized evidence summary. Production external blockers не изменялись. Изменения сохранены отдельными русскоязычными коммитами: имена файлов, текстовые загрузки, защита типа имени, интерфейс и доказательства. Итоговые SHA приведены в финальном сообщении. Запрещённый audit не читался/stage/commit.

## FINAL_FRONTEND_STATUS / REMAINING_GAPS / NEXT_STEP

| Classification | Итог |
|---|---|
| BACKEND_UI_PARITY | INCONCLUSIVE |
| ALL_VISIBLE_CONTROLS_FUNCTIONAL | INCONCLUSIVE |
| AUTH_UI | PASS |
| FILE_BROWSER_UI | PASS |
| FILE_OPERATIONS_UI | PASS |
| UPLOAD_UI | PASS |
| DOWNLOAD_UI | FAIL: required saved-browser-byte proof не получен |
| PREVIEW_UI | PASS |
| SHARING_UI | PASS для перечисленных core flows, включая expiry/pagination |
| TRASH_UI | PASS |
| DESKTOP_RUNTIME | PASS для проверенных core flows |
| MOBILE_RUNTIME | PASS для проверенных core flows |
| KEYBOARD_ACCESSIBILITY | INCONCLUSIVE |
| CONSOLE_NETWORK_HEALTH | PASS в наблюдавшейся dev campaign |
| INDEPENDENT_REVIEW | REJECT (functional); code APPROVE отдельно |
| FINAL_FRONTEND_FUNCTIONAL_ACCEPTANCE | INCONCLUSIVE |

PASS ограничен зафиксированными сценариями; не означает исчерпывающую проверку каждого control/edge. DOWNLOAD_UI FAIL означает невыполнение обязательного saved-byte критерия, а не доказанную порчу данных.

Остатки: ручная browser смена пароля не выполнена из-за правила инструментов об автономном изменении credentials; handoff не выполнялся. Требуется пользовательский ручной flow либо допустимый supervised путь. Exact saved browser download bytes не подтверждены. Forced409/413 и полный перебор ошибок/клавиатурных состояний не выполнялись. Тесты и HTTP доказательства не закрывают эти browser gaps.

NEXT_STEP: закрыть перечисленные доказательные пробелы, выполнить независимую functional приёмку и тогда присвоить окончательные бинарные fields. До этого frontend не объявляется полностью принятым; production readiness остаётся NOT_READY.

Одноразовый основной стенд сохранён для ручной проверки смены пароля и браузерного скачивания владельцем; отдельная тестовая PostgreSQL удаляется после прогона. Это не production deployment.
