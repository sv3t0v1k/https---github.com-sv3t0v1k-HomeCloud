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

## Targeted closure checkpoint — 2026-10-02

Verified main, HEAD `06c6d8666001c8c18b3ee8f6d93825f1f63915f5`, only the existing forbidden untracked audit; audit contents never accessed. Preserved stand alive at `http://127.0.0.1:18086`; served HTML/JS/CSS hashes equal current production build. Old runtime source copy is not used as version proof.

Working evidence: `docs/evidence/frontend-functional/closure-checkpoint.json`; control matrix: `closure-controls.json`, 89 rows, 54 bounded prior/new evidence rows, 35 INCONCLUSIVE. Counts do not establish exhaustive PASS.

Fixture1768 bytes, SHA256 `fbfbb3b052fc62f158c5eac87581e549d0bace45f842cde8a23d363426548133`: UI uploaded, Enter renamed, copied into folder5. Browser download event timed out15000ms; no new fixture in Downloads at inspection. Human save requested; saved bytes INCONCLUSIVE; HTTP body is not a substitute.

New keyboard proof: menu Enter/Space/End/Home/ArrowDown/ArrowUp/Escape+focus return; rename ShiftTab/Tab boundaries, Enter+focus return; move select+Space cancel; copy real destination-load error+disabled select/submit+retry+successful nested copy. Error HTTP status not captured. Login invalid Enter+Russian error without spinner+Tab/reverse. Account Enter+modal boundaries+profile Enter saved notice. Password UI_PRESENT, exact form open with empty fields; human credential entry/submission pending. No new credential entered or stored by agent.

Current file endpoints do not produce duplicate-name409; duplicate folder allowed. Generic409 component tests are not runtime409. Remaining error/keyboard/mobile/control evidence and final console/network pass pending. Observed warn/error arrays empty, not an exhaustive final health verdict.

Gate:17/17 suites,130/130 tests; lint PASS; tsc-b PASS; production build PASS; diff check PASS before docs checkpoint. Backend unchanged and not retested. No confirmed new defect. Independent reviewer inspected checkpoint and confirmed evidence incomplete; final verdict not yet requested.

Acceptance remains INCONCLUSIVE. Next: human password/save actions, remaining control/error/keyboard proof, final gate and independent review. No numbered Phase, production blockers unchanged.

## Targeted correction after owner check — 2026-10-03

### INITIAL_STATE

HEAD `06c6d8666001c8c18b3ee8f6d93825f1f63915f5` confirmed. Actual initial status differed from expectation: report already modified; `closure-checkpoint.json` and `closure-controls.json` already untracked, alongside forbidden audit. Existing checkpoint preserved. Forbidden audit contents not accessed; no wildcard staging. Stand and data retained.

### EMPTY_FOLDER_ROOT_CAUSE

Owner Safari actually showed `http://127.0.0.1:8080/files`, user `preview@homecloud.test`, zero files/folders, no Account button, and an earlier quota upload error. This is the older production-preview, not acceptance stand. Fresh hashes prove 8080 HTML/JS/CSS differ from current build; 18086 HTML/JS/CSS match current build exactly. The earlier handoff supplied the wrong stand/account. Acceptance API root already held file65 (previous fixture); owner was inspecting a separate user's separate stack. No product missing-account defect established on current HEAD.

Initial sandbox connection failure did not mean the stand was down: Docker containers were running. Setup requests through environment proxy returned502; direct local requests without external proxy succeeded. A bounded acceptance nginx reload was performed during diagnosis; no data or other stack changed.

### SEEDED_DOWNLOAD_FIXTURE

Work created file67 through normal uploads/session → chunk → complete under existing acceptance user, root folder. Filename `homecloud-acceptance-download-20261003.txt`, UTF-8 deterministic content,1297 bytes, SHA256 `2e503a1657f4dd84936bacc953ad1e9c1b5b5a83f85b1ce65b32894e20b0aeba`. Source `/private/tmp/homecloud-acceptance-download-20261003.txt`. Safari authenticated root visibly shows this file. Owner did not source or upload a fixture. A one-day/max10 temporary public link was created only for disposable fixture data; token omitted from committed evidence.

### BROWSER_DOWNLOAD_BYTES

PASS for this fixture: Safari public Download button, native download permission, then authenticated owner overflow menu ArrowDown+Enter. Safari Downloads shows two completed entries. Real saved file `/Users/aleksejkozemakin/Downloads/homecloud-acceptance-download-20261003.txt` inspected after owner action:1297 bytes, identical SHA256 and filename. Saved mtime is recorded in correction evidence. Server Content-Disposition is `attachment; filename="homecloud-acceptance-download-20261003.txt"`. Owner UI uses Blob plus anchor.download=file.name, so response disposition and saved filename are separate observations. HTTP equality is recorded separately and is not the saved-byte proof. Previous unverified ZIP/download variants do not automatically become PASS.

### PASSWORD_CAPABILITY_CLASSIFICATION

`USER_CAPABILITY_UI_PRESENT_AND_REACHABLE`. Backend POST auth/change-password uses normal JwtGuard and authenticated user's own ID, verifies old password, hashes new password, revokes refresh tokens. This is intended end-user capability, not admin/internal. Current App Navbar already renders Account button opening AccountDialog on protected file/trash routes. Fresh Safari runtime: normal Account button opens live quota, profile and current/new/confirmation fields. Labels/autocomplete and mismatch/error behavior additionally checked in current component tests. Criterion retained.

### ACCOUNT_PROFILE_NAVIGATION

PASS for normal Account entry and dialog contents on current stand; live usage4833/quota1073741824,3 files/54 folders observed. Sidebar name/email are static text, not dead interactive controls. New App integration regression opens dialog from visible navigation, verifies quota/profile/password fields and Escape focus return. Owner manually signed in without sharing credentials in chat.

### PASSWORD_UI_REMEDIATION

No new product UI required: surface already exists and is reachable on correct version. Corrected stand/address/account handoff, added navigation regression. Browser rule requires owner entry, confirmation and submission of new credentials; agent entered none. Exact reachable form prepared for manual change/relogin; result pending.

### REMAINING_CLOSURE_CHECKS

Owner file menu ArrowDown+Enter download observed; public download permission/success verified. IAB public warn/error log arrays empty. Full authenticated final network pass, outstanding control/mobile/error/keyboard rows, password mutation/relogin and ZIP saved bytes still require evidence. No comprehensive already-passed campaign restarted; no forced409 claimed where backend permits duplicate names. Browser DOM read-only API does not expose performance network entries; failed request for them was not counted as network proof.

### FULL_FRONTEND_GATE

Focused19/19; full17 suites131/131; lint PASS; TypeScript via tsc-b PASS; production build PASS. Initial new-test type error (unsupported exact option) fixed before final gate. Backend source unchanged; backend suite not rerun. Final git diff --check PASS.

### INDEPENDENT_REVIEW

Independent reviewer confirmed user capability and existing code reachability; warned that code tests do not substitute authenticated browser evidence and HTTP bytes do not substitute saved bytes. Final independent review: APPROVE correction checkpoint after fixing stale wording in JSON classification. Reviewer explicitly verified fixture responsibility, correct password classification/reachable UI, real saved-byte evidence and evidence-based INCONCLUSIVE. Full functional verdict remains INCONCLUSIVE.

### DOCS_UPDATE

Appended correction without erasing earlier checkpoints. New sanitized `docs/evidence/frontend-functional/correction-20261003.json` records fixture, exact saved bytes, build hashes and limitations; no passwords/refresh tokens/share token included.

### COMMITS / FINAL_HEAD / GIT_STATUS

Correction saved in a separate Russian-message checkpoint commit (SHA reported in final response). Pre-existing closure-checkpoint.json and closure-controls.json retained untracked separately; forbidden audit untouched. Final HEAD/status verified after commit.

### FINAL_FRONTEND_FUNCTIONAL_ACCEPTANCE

INCONCLUSIVE: fixture and current account reachability gaps corrected; tested saved fixture bytes PASS. Password end-to-end and remaining closure matrix are still unverified. Production readiness unchanged.

### REMAINING_GAPS / NEXT_STEP

Complete manual password change/relogin from proven reachable current form; verify result, continue bounded remaining closure and independent final review. Do not send owner back to8080 or ask owner to locate/create download test data.

## Исправление ввода в аккаунте — 2026-10-03

INITIAL_STATE: HEAD `7b05be973602be6749f198e7f335e845c5c8eb38` совпал. Прежние два untracked checkpoint сохранены; запрещённый audit не читался и не изменялся. Стенд18086 и данные сохранены; заменены только статические frontend build-файлы его контейнера. Другие контейнеры не изменялись.

RUNTIME_REPRODUCTION: Safari; клики по трём password inputs и имени, а также Tab возвращали фокус на «Закрыть». Runtime DOM: disabled/readOnly/inert false, pointer-events auto; profile hit-test попадал непосредственно в input.

ROOT_CAUSE: общий useDialogFocus восстанавливал потерянный фокус через queueMicrotask. Safari выполняет microtask checkpoint внутри native перехода фокуса: focusout оставляет activeElement BODY, repair фокусирует Close до завершения перехода на INPUT. Снятая трасса: mousedown INPUT → focusout BUTTON (active BODY) → focusin BUTTON → mouseup/click INPUT (active BUTTON). Дефект затрагивал также профиль. Safari-only специфичность не установлена: authenticated Chromium comparison и другие modal runtime inputs в этом проходе не проверялись.

FIX: repair перенесён на setTimeout(0); предыдущий timer отменяется при повторном событии и cleanup. Синхронный focusin trap сохранён. Account opener явно получает focus перед открытием: Safari mouse click не фокусирует button самостоятельно, поэтому без этого Escape возвращал BODY. CSS/DOM, дизайн и backend не менялись.

REGRESSION_TESTS: Account enabled/editable, click/type, Tab и reverse boundary; Safari focusout microtask checkpoint до native input focus, последующий repair реально потерянного фокуса. App integration использует account.click() без искусственного userEvent автофокуса и проверяет Escape restore. Общие consumer tests preview/trash/sharing также входят в full gate.

SAFARI_RUNTIME_VERIFICATION: конечный build `index-B6iELFq4.js` подтверждён inspector DOM, desktop width1394. Все три поля принимают pointer focus и одиночный диагностический символ; символы удалены, форма не отправлялась. Narrow responsive mode390×844: три поля также принимают клик и символ, нижняя область достижима прокруткой, overlap элементами страницы не обнаружен. Это desktop Safari responsive mode, не физический iPhone. Консоль HomeCloud после reload пустая; ранняя SyntaxError была ошибкой ввода диагностической команды оператора, не приложения.

KEYBOARD_FOCUS_VERIFICATION: обычный Tab достигает profile/password inputs, Safari default пропускает buttons. Option+Tab проходит Close → Name → Avatar → Save profile → Current → New → Confirmation → Change password → Close; Option+Shift+Tab возвращает Close → Change password. Escape закрывает и возвращает focus на Account opener. Проверенный клик по desktop backdrop не активировал фон.

FULL_FRONTEND_GATE: targeted17/17, full133/133 в17 suites, lint, tsc-b, production build, git diff --check PASS. Backend неизменён, его проверки не запускались.

Доказательства: `docs/evidence/frontend-functional/account-focus-20261003.json` содержит ограниченные сырые excerpts UI/event outputs и ограничения; полная видеозапись отсутствует. INDEPENDENT_REVIEW: APPROVE. Независимый reviewer проверил конечный diff, сырые bounded browser excerpts и самостоятельно выполнил targeted17/17 PASS. Blocking findings нет. Reviewer не повторял browser runtime; это review доказательств, не второй независимый browser прогон. Ограничения Chromium/global modal runtime и password mutation/relogin сохранены.

ACCOUNT_FIELDS_FOCUSABLE / ACCOUNT_FIELDS_EDITABLE / POINTER_INPUT / KEYBOARD_INPUT / DIALOG_FOCUS_TRAP / SAFARI_ACCOUNT_RUNTIME: PASS в перечисленном scope. PASSWORD_CHANGE_FLOW: READY_FOR_MANUAL_ENTRY. Полная frontend functional acceptance остаётся INCONCLUSIVE до password submission/relogin и прежних незакрытых closure checks.

NEXT_STEP: оставить обычный Safari на пустой password form; владелец вводит текущий/новый/подтверждение и отправляет. Затем проверяется relogin и продолжается существующий targeted closure. Credentials не отправлять в чат. Ручной ввод/подтверждение/отправку требует Browser Computer Use policy: “Changing a password or other authentication credential”.


## Итоговое закрытие функциональной приёмки — 2026-10-03

Этот раздел заменяет прежний текущий verdict INCONCLUSIVE, сохраняя историю проверок. Scope: существующие intended возможности frontend, Safari desktop и desktop responsive mode 390×844 на acceptance стенде18086. Не заявляется сертификация всех браузеров, физического iPhone, всех размеров/комбинаций архивов или production readiness. Backend thumbnail endpoint остаётся auxiliary presentation без отдельной UI capability; регистрация, поиск, resume и прочие roadmap возможности не добавлялись. BACKEND_UI_PARITY не приравнивается к функциональной приёмке текущего UI.

INITIAL_STATE: фактический HEAD `a2dff81a933b29c156379d2d1a457ab9d052ff9c` совпал с ожидаемым. Три исходных untracked файла сохранены. Запрещённый audit не читался, не менялся и не индексировался. Стенд18086 и его данные сохранены; старый preview8080 не менялся.

PASSWORD_CHANGE_AND_RELOGIN: PASS. Прямое свидетельство владельца: заполнил current/new/confirmation, отправил форму, приложение сразу перенаправило на авторизацию, успешно вошёл новым паролем. Агент не вводил и не запрашивал credentials. Свидетельство о мутации отделено от непосредственного наблюдения: после этого Safari показывает защищённый `/files`, reload восстанавливает сессию, Account открывается. Контракт AccountDialog завершает текущую сессию после успешной changePassword; backend отзывает refresh tokens. Логи password запроса и самостоятельная повторная смена пароля не заявляются.

POST_RELOGIN_SESSION: PASS. Защищённые Files/Trash и Account достижимы, refresh/reload возвращает authenticated UI без redirect loop. Отдельно реально истёк access token: до исправления quota Retry получал403 и не обновлял сессию; после исправления тот же браузер без reload прошёл `storage-info401 → refresh200 → storage-info200`. Финальный reload: refresh200, users/me200, folders200, files200; Account storage-info200.

CONTROL_MATRIX: PASS в scope. Финальная матрица [final-controls-20261003.json](evidence/frontend-functional/final-controls-20261003.json): 89 строк, 87 PASS и2 NOT_APPLICABLE, 0 INCONCLUSIVE. Из прежних35 остаточных строк33 закрыты наблюдением UI/явно названным прежним core evidence;2 исключены по проверенному контракту. Прежние54 PASS переиспользованы, а не представлены новым прогоном. Проверены skip-link, list/grid, folder row/card, file preview/card, точные file/folder menu actions, create Enter/Close, upload retry/disabled, preview unsupported/loading abort, sharing Enter/close, public retry, trash confirmations, Account retry и drawer. Успешные rename/move/trash/purge mutations, ранее доказанные, не выполнялись повторно только ради закрытия exact entry/focus rows. На этом проходе permanent Delete/Empty были отменены, disposable soft-trash затем восстановлен.

KEYBOARD_MATRIX: PASS в scope. Enter/Space активируют проверенные actions; menu Arrow/End, Escape, Option+Tab и Option+Shift+Tab покрывают соответствующие границы и возврат focus. Safari обычный Tab зависит от системного Full Keyboard Access; для buttons использован Option+Tab. Disabled Upload пропущен; create disabled submit пропущен. Preview, create, sharing, permanent/empty confirmations, Account и mobile drawer имеют проверенные границы. Pointer opener focus для нескольких окон сначала FAIL, затем исправлен и повторно проверен; native click regressions не подставляют искусственный userEvent focus.

ERROR_EDGE_MATRIX:

| Класс | Итог | Доказательство |
|---|---|---|
|401|PASS|Прежний invalid login; текущий реально истёкший access и401→refresh→retry без reload.|
|403|PASS|Прежний публичный неверный пароль и реальная нулевая квота; истёкший JWT403 оказался новым дефектом и исправлен на401.|
|404|PASS|Прежняя чужая/missing folder; текущая отозванная disposable public ссылка после reload и Retry.|
|409|NOT_APPLICABLE|Production ConflictException только duplicate registration email; текущий UI не имеет регистрации. Duplicate folder names разрешены. Искусственный mock409 не подменяет runtime.|
|quota|PASS|Ранее реальное ограничение при нулевой квоте; текущие usage/counts и восстановление quota Retry.|
|network|PASS|Реальная остановка только acceptance frontend: upload/quota/public error; запуск и штатные Retry восстановили работу.|
|5xx|PASS|Прежний фактический502 create-folder при backend stop, restart/retry без дубликата. Каждый отдельный500-код не заявляется проверенным.|
|cancel/abort|PASS|Прежний cancellation upload110MiB; текущий preview loading при backend pause закрыт Escape, после unpause не воскресает.|
|retry|PASS|Текущие upload/quota/public; прежний copy destination retry.|
|forced413|NOT_APPLICABLE для текущего стенда|UI chunk10MiB меньше nginx51m; oversized chunk validator400. Подмена запроса не intended UI action. Смена deployment limits потребует новой проверки.|
|multiple chooser / disabled revoked row|NOT_APPLICABLE|Один file input без multiple; revoked share удаляется из active списка, disabled row отсутствует.|

ZIP_DOWNLOAD_CLASSIFICATION: APPLICABLE / PASS. Кнопка «Скачать папку ZIP» существует в public folder UI. Реальный Safari download сохранён в Downloads и прочитан как ZIP, а не заменён HTTP-проверкой. Первый архив1655байт имел CRC PASS, но две записи `./`, потеряв имя пустой дочерней папки. После минимального исправления повторный UI download1685байт: CRC PASS; `./`, `Контроль/`, TXT1297байт с исходным SHA256 `2e503a1657f4dd84936bacc953ad1e9c1b5b5a83f85b1ce65b32894e20b0aeba`. SHA256 сохранённого ZIP `1da8b2e1b000d1cc1a16478249c80f482cfd07530958dd0653120e0337725ffd`. Путь и обе проверки в sanitized evidence. Кириллическое имя каталога сохранено; ASCII имя attachment и браузерный collision suffix не объявлены дефектом. Глубокие/огромные архивы не объявлены отдельно проверенными. Disposable link отозвана.

CONSOLE_NETWORK_PASS: PASS для финального bounded pass конечного production build `index-BnJffqb8.js`. Safari Web Inspector после fresh reload + Account:10 ресурсов,1 localhost domain,0 redirects, документ/JS/CSS/refresh/me/folders/files/storage-info200, шрифты200/304. Console после очистки/fresh reload и открытия Account не показывает записей ошибок или warnings. Ошибки ожидаемого network fault campaign отделены от финальной сети. Это наблюдение конкретного pass, не гарантия отсутствия любых будущих ошибок.

NEW_DEFECTS_AND_FIXES: три подтверждённых дефекта. (1) Safari pointer click не фокусирует opener: preview/create/drawer/permanent/empty после закрытия теряли focus. Добавлен явный focus actual opener перед open, native click regression и Safari повторная проверка. (2) ZIP root определялся совпадением entryName/member.name и терял имя прямой пустой child папки; проверяется member.logicalPath=="", тест читает central directory реального archive stream. (3) JwtGuard возвращал403 при истечении/отсутствии/невалидности authentication, блокируя interceptor refresh; теперь401 UnauthorizedException, security boundary tests сохраняют отказ до мутации и отсутствие echo token. Настоящее authorization403 сохранено. Редизайн и unrelated cleanup отсутствуют.

FULL_FRONTEND_GATE: PASS —17 suites,134/134; lint, TypeScript `tsc -b`, production build, git diff --check. Backend изменён:59 suites726/726, build PASS, lint0errors/15 прежних warnings. База тестов отдельная disposable PostgreSQL16 на18087, удалена после gate; acceptance DB не использована. Два промежуточных backend запуска с inherited proxy environment дали status mismatch в security.config; targeted19/19 и полный726/726 без proxy прошли. Точная причина промежуточного mismatch не доказана; тесты не ослаблялись. Код source/build установлен только на acceptance стенд; фактический final bundle проверен браузером.

INDEPENDENT_REVIEW: APPROVE. Независимый reviewer проверил конечный diff, отчёт и матрицу; самостоятельно прочитал сохранённый ZIP и подтвердил CRC/entries/hash. Blocking findings нет. Устаревшее wording в create rows исправлено по его замечанию. Reviewer не выполнял второй browser campaign; это независимый review доказательств.

DOCS_UPDATE: этот раздел; два новых sanitized evidence JSON — final-controls-20261003 и final-closure-20261003. Passwords, session/refresh/share tokens отсутствуют. Исторические checkpoints сохранены без правки; их прежние FAIL/INCONCLUSIVE относятся к предыдущему состоянию.

COMMITS / FINAL_HEAD / GIT_STATUS: изменения фиксируются отдельно: возврат фокуса, ZIP имена, authentication401/refresh, итоговый отчёт. Точные SHA/HEAD/status приводятся в финальном сообщении после commits, чтобы документ не ссылался на собственный будущий hash. Три исходных untracked файла не включаются.

FINAL_FRONTEND_FUNCTIONAL_ACCEPTANCE: PASS в заявленном scope. Все перечисленные текущие intended capability/control gaps имеют достаточное evidence; unresolved blocking gaps нет; независимый review APPROVE. Исходный claim о полной backend parity не расширяется этим заключением.

REMAINING_GAPS: unresolved blocking gaps по текущему scope нет. Ограничения: нет физического mobile/new Chromium campaign, полного перебора размеров/глубины ZIP и production readiness проверки. Это границы приёмки, а не выдуманные NOT_APPLICABLE capabilities.

NEXT_STEP: текущая функциональная приёмка закрыта; production readiness рассматривается отдельной задачей. Safari оставлен авторизованным на обычной странице файлов стенда18086; новых credentials от владельца не требуется.


## Отдельный UI-polish — 2026-10-03

Baseline: `main = origin/main = 97ce78879db495c7fc3ab356e2b2d0aab6e30309`, ahead/behind 0/0. Это отдельная ненумерованная правка после предыдущей Safari-приёмки; прежние runtime-доказательства не доказывают новую сборку.

Размеры списка/плитки, выбранного файла, переданных данных загрузки и сообщения о лимите скачивания используют единый `frontend/src/ui/formatBytes.ts`. Квота AccountDialog использует тот же форматтер: «Использовано X из Y», плюс native progress. Основание единиц — существующие 1024; русская запятая, максимум один десятичный знак, целые значения без лишнего нуля. Целочисленные строки BIGINT обрабатываются точно; отрицательные, дробные, неизвестные и небезопасные числовые значения дают «Нет данных». Единицы ограничены ТБ; большие величины сохраняют значение в ТБ. Индикатор вычисляется целочисленно и ограничен 0–100, текст usage не ограничивается квотой. Нулевая/неизвестная квота не порождает процент.

FolderEntity и FolderItem не содержат авторитетного aggregate size; папки по-прежнему показывают «—», без фиктивного «0 Б» и рекурсивного вычисления. Корзина, preview и share не показывают числовой размер и новых размеров не получили. API и backend не изменены.

Отдельная кнопка «Аккаунт» удалена из topbar. Вся область аватар/имя/email в sidebar — native button с accessible name «Открыть аккаунт: имя», состояниями hover/focus/active. Desktop и mobile drawer используют существующий AccountDialog; logout остаётся отдельным topbar-действием. Фокус явно ставится на opener перед открытием для Safari. При аккаунте над мобильным drawer его ловушка временно приостанавливается; закрытие аккаунта возвращает фокус в identity, закрытие drawer — в исходную кнопку меню.

Проверки кода: focused 72/72; full frontend 161/161 (18 файлов); lint, TypeScript `--noEmit`, production build и `git diff --check` PASS. Независимый read-only reviewer проверил formatter, API-семантику папок, квоту, доступность и scope; блокирующих дефектов кода не нашёл, дополнительно подтвердил focused 72/72.

Runtime новой production-сборки: PASS в bounded UI-polish scope. После прямого разрешения владельца проверен disposable localhost:5187 с детерминированными API fixtures, без изменения backend или пользовательских данных. In-app browser: 1440, 768 и 390 px; список/плитка, размеры Б/КБ/МБ/ГБ/ТБ, папка «—», квота 18,6 ГБ из 100 ГБ, отсутствие горизонтального overflow и сырых значений. Click, Enter/Space открывают аккаунт; close/Escape возвращают фокус в identity; на 768/390 закрытие drawer возвращает фокус в кнопку меню. Отдельный logout на 390 привёл на экран входа. Console warnings/errors не обнаружены. Снимки визуально проверены; внутренний scroll существующего диалога сохраняет доступ к длинной форме.

Нативный Safari: текущая production-сборка, размеры/папки/квота, progress 18,59%, identity click/Enter/Space, close и Escape с кнопки закрытия возвращают фокус в identity. Текущий пароль принимает тестовый ввод; поля нового пароля/подтверждения получают видимый фокус. Новые credentials не вводились и форма не отправлялась. Escape из поля подтверждения один раз не закрыл окно; такой же результат воспроизведён на неизменённом прежнем стенде localhost:18086. Это существующее поведение, не регрессия UI-polish; причина перехвата браузером не установлена.

Доказательства: `docs/evidence/frontend-functional/ui-polish-20261003/evidence.json` и снимки в той же папке. Предыдущая frontend acceptance не переобъявляется и новая numbered Phase не создаётся. Исходные checkpoint/controls сохранили SHA256; запрещённый audit не читался и не менялся. Теги и push не выполнялись. INDEPENDENT_REVIEW: APPROVE. Независимо проверены код, focused 72/72, runtime JSON и снимки 1440/390; блокирующих замечаний нет. Оговорка о прежнем Safari Escape сохранена. UI_POLISH_STATUS: PASS в заявленном bounded scope.


### Уточнение проверки Escape в Account в нативном Safari — 2026-10-03

Baseline: `496b0607454b87b3cc4962353f9690c7fb630496`, main ahead/behind origin/main 1/0. Код приложения не изменён. Повторно использован localhost:5187 с детерминированными API fixtures; Docker и backend не изменялись. Свежая production-сборка совпала с проверенным runtime asset `index-DSZGfHQm.js`, SHA256 `0440f4ffd723ae3254b3c3a0be9307b6bc40c067eb645176cebe4863f9fd3a93`.

При автоматизированном native Escape из пустого текущего password input Account дважды оставался открыт. Диагностические document capture/bubble listeners не зарегистрировали ни keydown, ни keyup этих попыток. Успешная автоматизированная попытка из confirmation input зарегистрировала keydown INPUT и keyup BUTTON. Отсутствие DOM-событий не объясняется фазой текущего document bubble handler; смена его на capture не обоснована. Конкретный источник недоставки клавиши (системный ввод, Safari либо автоматизация) не установлен.

Владелец нажал физический Escape из того же текущего password input: окно закрылось. Далее подтвердил 9/9 закрытий — по три из каждого пустого password input. Native Safari desktop viewport 1394 px. Трасса зарегистрировала 11 capture keydown и 11 capture keyup с учётом двух предварительных успешных попыток: текущий пароль 4, новый 3, подтверждение 4. Доставленные keydown имели isComposing=false; keyup приходили на BUTTON. Console проверка последнего activeElement: `Открыть аккаунт: Проверка интерфейса`. Значения password fields не записывались; credentials не вводились, формы не отправлялись.

Mobile Safari responsive mode 390×844 подготовлен, Account доступен через identity в drawer. Результат девяти физических повторов пока не получен; mobile PASS не заявляется. Новая console-error qualification, заполненные поля, autofill-popup/composition, исчерпывающие pointer/Tab/background runtime проверки в этом проходе не квалифицированы.

Gates на неизменённом frontend: focused Account/App 18/18; полный набор 161/161; lint PASS; typecheck и production build PASS; git diff --check PASS до документационного дополнения. Backend tests не требуются: backend не изменялся. Исходные два untracked JSON сохранили SHA256; запрещённый audit не читался и не изменялся.

INDEPENDENT_REVIEW: подтверждено отсутствие обоснования для смены listener phase и искусственного fail-before regression. Код не исправлялся; нового regression test нет, поскольку отказ приложения при доставленном Escape не воспроизведён, а root cause не установлен. Исторический gap не объявлен устранённым. ESCAPE_DEFECT_STATUS: НЕ ПОДТВЕРЖДЁН В ПРОВЕРЕННОМ ФИЗИЧЕСКОМ DESKTOP-СЦЕНАРИИ; remediation PASS не заявляется. Для закрытия нужен исходный отказ с подтверждённой доставкой клавиши либо уточнение условий прежнего наблюдения. Commit/push/tags не выполнялись.


### Оформление публичного доступа — 2026-10-03

Bounded pass A, исходный HEAD `496b0607454b87b3cc4962353f9690c7fb630496`. Route `/share/:token`, `PublicSharePage`; public API: GET link, POST verify, POST download, GET children (pagination/parent context). Реальные возможности: анонимное скачивание файла, пароль, содержимое папок, дочерний файл, ZIP. Public media preview отсутствует; PNG/PDF/video не получают выдуманный viewer. Ограничение browser-buffer 100 МиБ сохранено. Expired/revoked/invalid возвращают один и тот же 404; UI честно объединяет их и предлагает реальный повторный GET.

Визуальная система: graphite/warm-neutral фон, спокойное radial illumination на CSS, матовая карточка с тонкой границей и мягкой глубиной, минимальный зелёный акцент, существующий локальный Manrope и токены. Filename — h1 с полным доступным именем и overflow-wrap:anywhere; canonical formatBytes, MIME из FileEntity; download — основное действие. Для папки ZIP показан явно, aggregate size не выдуман. Защищённый ресурс, ошибка пароля, загрузка и terminal state используют ту же карточку. Footer точно: «Безопасный доступ через HomeCloud».

Минимальное additive исправление существующего API: GET раскрывает только name/size/mimeType у unprotected share; successful POST verify повторно проверяет доступность и отдаёт ту же безопасную projection. Protected GET не раскрывает имя/размер/MIME. Folder size/MIME равны null. storagePath/checksum/user/password не включаются. Ответы no-store. Guards, counters, password policy и механизм download не менялись.

Runtime: существующий `homecloud-preview`, frontend http://localhost:8080, PostgreSQL и backend реальные. Текущие собранные dist применены к этим контейнерам, исходные runtime artifacts сохранены в /private/tmp/hc-dual-preview-*-before. Нового Docker stack/контейнера нет. Использованы отдельные тестовые User/files/shares: квота назначена только тестовому User; expiry изменён только у новой тестовой ссылки. В начале обнаружена stale nginx logging config этого preview; она синхронизирована с уже tracked `frontend/nginx.conf`, nginx -t и reload PASS. Исходники proxy не менялись. До sync тестовые tokens попадали в прежний access log; после sync повторные HTTP/runtime запросы пишут только status/bytes/duration. Все шесть тестовых ссылок отозваны: DELETE 200, последующий anonymous GET 404 для каждой (fixture-cleanup.json); исторические logs не удаляются. Прямой preview :8080 не предоставляет CSP header; TLS/production ingress CSP в этом UI-проходе не переквалифицированы.

IAB: ordinary long filename, password, wrong password/unlock (Enter), PNG without fake preview, folder/ZIP, expired/revoked/invalid — 1440/768/390/375 px; measured document.scrollWidth равен viewport width. Focus outline solid, публичная страница не запирает фокус. Errors role=alert, loading/notice role=status, пароль labelled/current-password с aria-invalid/describedby. Safari: длинное имя 1440/768/390/375, wrong password и successful unlock, PNG download, folder/terminal states desktop и mobile. После завершённого logout повторно квалифицирован ordinary 375: прежний ранний снимок ещё содержал login и заменён корректным evidence.

Реальный Safari download `pixel.png`: 68 bytes, SHA256 `f3ec9e14b9c085b55edc96155f7bd26b6fdeda2462f02af4e0279d8319b365e3`, совпадает с API. HTTP normal/protected file: 18432 bytes, SHA256 `930f060873be803327d7d20fd5514b26d59bec0521f6f2d532bc91190676c2cb`. ZIP: 233 bytes, PK0304 signature. IAB ZIP click завершился status «Скачивание подготовлено»; событие download этого инструмента для blob-save не вернулось, поэтому disk-save квалифицирован в native Safari.

Focused frontend 38/38; full frontend 169/169; lint, TypeScript, production build, diff-check PASS. Backend focused 82/82; full 699 PASS, 32 PostgreSQL tests skipped стандартным gate без отдельного test DATABASE_URL; lint 0 errors/15 existing warnings, build PASS. Реальный PostgreSQL API path отдельно проверен на используемом preview. Evidence: `docs/evidence/frontend-functional/share-account-polish-20261003/`.


### Аудит возможностей и интерфейс аккаунта — 2026-10-03

Bounded pass B. Источники: UserEntity, UpdateProfileDto, UsersController/UsersService, AuthService/RegisterDto, frontend User/SessionContext/account api, App/AccountDialog.

| Возможность/поле | Классификация | Фактический контракт |
| --- | --- | --- |
| name | SUPPORTED_EDITABLE | Persisted varchar(100); GET/PATCH /users/me. При регистрации name либо email local-part, в entity default User. Не догадка UI о человеческом имени. |
| email | SUPPORTED_READ_ONLY | Persisted unique varchar(255), GET me; update DTO не принимает email. |
| avatar string | SUPPORTED_EDITABLE | Nullable varchar(255), GET/PATCH me, произвольная строка; визуальное фото не отображается. Теперь backend-only editable value: misleading UI editor удалён. |
| avatar image/upload/crop/removal | NOT_SUPPORTED | Нет image API/storage/URL validation/render lifecycle; строка не является реализованной фото-функцией. |
| displayName / firstName / lastName | NOT_SUPPORTED | Таких полей/API нет. |
| Общий user icon | DERIVED_UI_ONLY | Фиксированный Icon user в identity и Account; не фотография и не инициалы, не зависит от avatar string. |
| Инициалы | NOT_SUPPORTED | Текущий UI их не вычисляет. |
| id/isActive/isEmailVerified/createdAt/updatedAt | SUPPORTED_READ_ONLY | Persisted, GET me, не редактируются профилем. |
| storageQuota/storageUsed/fileCount/folderCount | SUPPORTED_READ_ONLY | Quota/used persisted User; counts вычислены storage-info API. Нет UI/API изменения квоты пользователем. |
| Password change | SUPPORTED_EDITABLE | POST auth/change-password с oldPassword/newPassword; пароль в GET me отсутствует. После успеха локальный logout; остальные access sessions до expiry. |
| Password hash | NOT_SUPPORTED для чтения/редактирования профилем | Persisted auth field, исключён из GET/PATCH me response; только специальная password flow. |

Account компактен: профиль с фактическими name/email и доступным общим значком; форма имени; хранилище с «Использовано X из Y» и точным ограниченным percent; безопасность с прежней password form. Заголовки h2/h3. Fake photo editor удалён. Name save отправляет только name, без неявного перезаписывания avatar или преобразования null в ''. Реальная UI mutation и последующий GET подтвердили сохранность заранее заданного тестового avatar string. Identity block остаётся каноническим opener; App/navigation/logout не изменены. focus hook и Escape handler не менялись.

Runtime IAB: Account 1440/768/390/375, один visible identity opener, name/email, quota 36,2 КБ из 100 ГБ; progress 0% соответствует существующему округлению небольшого usage. Password поля доступны и принимают dummy probe; значение DOM automation redacts, отдельный native Safari masked input подтверждает ввод. Tab last→close и visible solid outline, Close/Escape→identity. Mobile drawer focus restoration, независимый logout до login. Safari Account 1440/390/375: профиль, quota, три password inputs; dummy input на desktop, доставленный Escape из confirmation закрыл и вернул identity; mobile Close вернул identity. Password form не отправлялась, пароль владельца не менялся. Ранний Safari logout snapshot был снят в переходе; поздний screenshot подтвердил login, основная logout qualification — завершённый IAB сценарий.

Уточнение ранее dirty Escape evidence: исходное дополнение выше сохранено целиком как исторический результат. Владелец позднее сообщил «Ручной тест escape я провел» и подтвердил физический Escape в согласованном scope. Предыдущие automation failures без DOM keydown/keyup не доказали дефект приложения. Новый patch/remediation Escape не придуман; исходные desktop 9/9 и трасса сохранены. Точные параметры/число новых физических mobile повторов владелец не перечислил, их не выдумываем. Это подтверждение рабочего пользовательского ввода в проверенном scope, а не доказанный defect/fix.

Опциональное будущее решение владельца: настоящее фото профиля. Минимум — определить семантику существующего avatar (storage key или validated URL), authenticated upload/remove API, ограничения MIME/bytes/dimensions, обработку/очистку прежних файлов, controlled serving/CSP, frontend image/fallback и security/accessibility tests. Новые поля имени не нужны для уже поддержанного name; email editing требует отдельной verified-email/auth policy. Сейчас это не реализовано.

Console/network: IAB 0 recorded error/warn; Safari единственная наблюдаемая console ошибка — ожидаемый HTTP404 invalid fixture, на нормальном ресурсе unexpected errors/CSP violations не обнаружены. Manrope loaded; current JS/CSS совпали с production build. После nginx sync proxy/backend logs не содержат проверенные тестовые passwords/tokens; 5xx нет. Новая numbered Phase не создавалась. 50 GiB и Docker cleanup не запускались.

INDEPENDENT_REVIEW: APPROVE. Независимо проверены source, capability matrix и runtime evidence; focused frontend 38/38, backend controller 9/9, diff-check PASS. Reviewer не повторял browser campaign. Blockers нет; отзыв шести тестовых ссылок и safe proxy logs подтверждены. Непрерывное наблюдение простоя 20 секунд: 0 новых запросов (idle-network.json). PUBLIC_SHARE_POLISH_STATUS / ACCOUNT_PROFILE_POLISH_STATUS: PASS в описанном bounded scope.
