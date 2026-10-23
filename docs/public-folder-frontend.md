# Public Folder Sharing — frontend, этап 5

Локальная реализация поверх backend `bc1a553`. Backend/API, CI/CD, Multi-Storage
и домашний сервер не изменялись. Production **NO_GO**, Multi-Storage **DEFERRED**.
Этап 6 и обновление сервера не начинались.

## Интерфейс и контракт

- В ShareDialog папки: «Разрешить загрузку», исходно выключено. Пароль, срок,
  download limit, копирование и отзыв сохранены. Изменение прав существующей ссылки
  остаётся отзывом и созданием новой ссылки; нового PATCH API нет.
- PublicSharePage сохраняет просмотр, breadcrumbs, pagination и native download.
  Разрешённая запись добавляет отдельные файлы, папки, mkdir, drag/drop, прогресс,
  actual names, результат по каждому исходному пути и повтор частичного задания.
- Публичные metadata не проецируют allowUpload. Используется существующий
  `POST /upload-authorizations`: успешная выдача proof включает управление записью,
  HTTP403 при первоначальной проверке оставляет чтение; network/429/5xx показываются
  отдельной ошибкой с повтором. Корень/выбранная папка берётся из `children.parentId`,
  а не из mirror fileId. Пароль и proof находятся только в памяти страницы.
- PublicUploadTransport подключён к **существующему UploadQueue**. Owner transport,
  discovery и сохранение обычных загрузок остаются прежними. Public discovery
  отключён, public очередь не использует persistent storage; запросы skipAuth /
  skipRefresh идут только по scoped public routes. Одновременно не более двух файлов,
  по одному chunk на файл. SHA-256 использует существующий потоковый wholeSha256.
- Публичного limits endpoint нет. Клиент использует локальную политику: chunk10МиБ,
  до10000 chunks на файл (локальный cap104857600000 bytes). Это **не** обнаруженные
  серверные лимиты: меньшие configured chunk/file/quota bounds остаются обязательными
  и могут дать отказ admission. Точные quota/access причины backend скрывает за403;
  интерфейс не обещает их различить. Автоматический новый proof на любой403 не вводился.

## Дерево, коллизии и повтор

Манифест ограничен1000 узлами, глубиной32 и4096 UTF-8 bytes пути; родители добавляются
до проверки общего cap. Запрещены traversal/absolute/drive/control names, file-as-parent,
дубликаты и разные исходные префиксы, сливающиеся после NFC/trim. Percent encoding
не декодируется. Эти клиентские bounds не заменяют серверную защиту.

Каталоги создаются сверху вниз: исходный путь → **возвращённый actual folder ID**.
Коллизия создаёт отдельный каталог с suffix, не объединяет его с существующим.
Target фиксируется при выборе; последующая навигация его не меняет. Дочерние операции
блокируются, если родитель не подтверждён; независимые ветви продолжаются.

Повтор mkdir сохраняет UUID/payload и перепроверяет receipt каждого родителя.
Потерянный create-session ответ повторяется с прежним ключом и payload без owner
session discovery. Известные file sessions сверяются через status; передаются
недостающие chunks, complete идемпотентен. Завершённые файлы при partial retry также
перепроверяются через status; move/delete/revoke не скрываются прежним success.
Общий retry/Retry-After budget переиспользуется из upload engine. Неопределённый
create после23 часов не повторяется: сервер не обещает tombstone после24 часов.

Импорт неатомарен: успешные папки/файлы остаются у владельца. UI не заявляет success
всего дерева при ошибках. Завершение partial batch требует отдельного подтверждения:
checkpoint теряется, повторный выбор может создать новые объекты. Закрытие/reload
вкладки также теряет checkpoint; server TTL очищает незавершённые сессии.

Пустой файл отклоняется с явным сообщением. Chromium directory handle и обнаруженные
FileSystemEntry позволяют сохранить пустые каталоги. Fallback webkitdirectory
содержит только обнаруженные файлы и может не сообщить пустые каталоги: ограничение
показано до выбора, предусмотрены drop и manual mkdir. Полнота необнаруженных каталогов
не заявляется.

## Проверка безопасности и независимый review

Read-only review backend подтвердил: live ancestors/mirrors, exact user/share/root
session binding, повторная policy/scope проверка перед commit, server-side download
confinement, checksum и receipt replay checks. Manifest браузера не является границей
доверия. Нового backend расширения для безопасности не потребовалось.

Независимый frontend review завершён **ACCEPT** после исправления: потери checkpoint
при listing retry, неоднозначных implicit parents, асинхронного fallback picker,
выхода из partial batch с empty file, перепроверки completed receipts, timeout status
и запрета discard работающего задания. Дополнительный ACCEPT получен для
синхронного loading при смене batch (исправлен воспроизведённый browser race). Автор проверил исправления по diff и тестам.
Review не заменяет результаты browser tests.

## Проверки и ограничения

Адресные frontend тесты:109 PASS (sharing + upload/uploadQueue), затем60 sharing
PASS после дополнительного regression fix. Полный набор:
25 suites /305 tests PASS. Lint: PASS, без предупреждений. Build: PASS.
Проверены public transport, SHA payload, target freeze/actual mapping, потерянный
create reply, blocked parent/replay, empty file, partial discard, moved completed file,
read-only UI и сохранение настроек owner share. Эти тесты **компонентные/модульные**.

Safari: NOT_RUN. Установленный Safari не разрешает Remote Automation; настройки
не менялись. Playwright WebKit binary отсутствует. Chromium fallback без
showDirectoryPicker не является проверкой Safari. Совместимость Safari остаётся
открытой браузерной приёмкой.

Chromium E2E: **11 PASS** в изолированном HTTPS fixture на Linux arm64 /Node20.20.2,
backend sources `bc1a553`, npm ci точного текущего package-lock. Lock SHA-256
`bc860443b0191b493fc636915d610d13f114318da3722f32f5918c47291a6cb2` проверен внутри
финального контейнера. Проверены read-only/nav, upload12МиБ+137bytes и native download
SHA-256, filechooser fallback без showDirectoryPicker, дерево5 уровней с коллизией,
пустая папка через synthetic FileSystemEntry drop, injected connection reset и
resume одной сессии/одного файла, server-side outside-tree404, quota reject/retry,
revoke/expiry с cached proof. На375px нет horizontal overflow; снимки проверены.
Это настоящий browser + backend, а не компонентные тесты или подмена API responses;
событие directory drop синтетическое, нативный OS drag не квалифицирован.

Первоначальные полные прогоны останавливались на empty-dir drop после смены batch.
После двух повторов подход сменён на отдельную lifecycle диагностику, которая
выявила race старого drop surface. Исправление подтверждено regression test,
отдельным Chromium сценарием и финальным чистым полным прогоном. Ранние отчёты
сохранены отдельно и не складываются с11 финальными проверками. Старый runtime
образ со старыми dependencies не засчитан как bc1a553: финальный fixture использует
npm ci текущего lock внутри одноразового контейнера.

[Финальный browser result](evidence/public-folder-stage5-20261023/public-folder-browser.json),
[проверки/runtime](evidence/public-folder-stage5-20261023/checks.json),
[desktop](evidence/public-folder-stage5-20261023/public-folder-tree.png),
[375px](evidence/public-folder-stage5-20261023/public-folder-mobile-375.png). Большие production payloads,
долгая assembly>5мин proof, NAS/power-loss и домашний mount не квалифицированы.
Входные1254 backend PASS этапа4 не прибавляются к результатам этого этапа.

## Повтор локального browser harness

Сначала frontend targeted → full → lint → build. Затем задать абсолютный внешний
`HOMECLOUD_BROWSER_WORKDIR`, выполнить `scripts/tests/public-folder-fixture.cjs`,
дождаться запуска disposable backend и выполнить `scripts/tests/public-folder-browser.cjs`.
`HOMECLOUD_PLAYWRIGHT_DIR` позволяет указать установленный Playwright.
В конце обязательно `scripts/tests/public-folder-fixture.cjs cleanup` с тем же workdir.

Harness использует существующий Docker fixture подход: текущие backend/src и
package/package-lock подключаются read-only, npm ci/build выполняются внутри
одноразового Linux контейнера; PostgreSQL/storage/network принадлежат этому запуску.
HTTPS сертификат self-signed, ignoreHTTPSErrors применяется только к localhost fixture;
доверие системного браузера/сервера не меняется. Secret fixture controls существуют
только в тестовом процессе. Private manifest, ключ сертификата и control key не
включаются в evidence/коммиты. Реальные rate limits не отключаются. Прерывание сети
инъецируется Playwright route.abort; остальные ответы идут от настоящего backend.
