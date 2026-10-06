# Финальный gate локальной версии — 6 октября 2026

Версия `v0.9.0-local.1`, GitHub prerelease. Production NOT_READY / NO_GO; Safari 50 ГиБ UNQUALIFIED. Исходный HEAD `167498dd60bb298168a8b8b8a5a7a6154e2137ee`; origin/main после fetch `97ce78879db495c7fc3ab356e2b2d0aab6e30309`, ahead20/behind0. Три исходных untracked файла сохраняются, запретный audit не читается/не staging.

## Проверки

- Backend: 63 suites, 825/825 PASS; PostgreSQL: 7 suites, 68/68 PASS без пропусков, включены в 825. Проверки используют отдельную временную БД/роль в canonical PostgreSQL через private loopback мост; DB/роль удалены, пользовательская БД не используется тестами.
- Release helpers: 50/50 PASS без пропусков; recovery config: 11/11 PASS.
- Frontend: 19 files, 218/218 PASS. Backend/frontend lint, typecheck, build PASS; backend lint 0 errors/15 прежних test warnings; compiled file-type import PASS.
- Restore schema: 9 regression tests (11 случаев с subtests) PASS; cleanup regression 1 PASS; `bash -n` PASS. [Реальная проверка schema-only dump](restore-schema-runtime.json): текущие9/переходные8/старые7 принимаются, неизвестная таблица, view вместо base table и неполная схема отклоняются. Выполнено в отдельной удалённой после проверки БД без нового Docker-стека. Это не полный новый destructive DB/storage restore drill.
- [Runtime smoke](runtime-smoke.json): четыре canonical services healthy/OOM false/restarts0; Compose config и nginx-t PASS, readiness/HTTP/HTTPS с явной CA200; dev login/files/limits API PASS; произвольный unknown-type binary256КиБ upload/native HTTPS download SHA-256 equality PASS. Только свой файл удалён, storageUsed0 восстановлен, своя refresh-сессия отозвана. Пароли/токены в evidence не сохраняются.
- UI: обычный вход, `/files`, очередь выбора/загрузки и пустое хранилище видимы; logout проверен. [Снимок](ui-smoke.png).
- [Полная 50 ГиБ квалификация](../browser-50gib-qualification-20261006/report.md) повторно прочитана: три SHA-256, 5120 частей, сохранённые479, Pause/точечный обрыв/reload-reselect, Cancel, cleanup, независимый ACCEPT. Полный повтор не выполнялся.

## Аудит документации и исправления

Независимый read-only audit проверил все46 tracked текстовых документов, Compose/env examples и соответствующий код. Исправлены: README Router/Compose/clone/registration/resources/hash terminology/private health; Phase/state и current-vs-historical статусы 50ГиБ/O(N²)/Blob/лимитов/TLS/test totals; runtime/Redis/secrets; auth memory/sessionStorage/key invalidation/native cookie boundaries; девятитабличная backup схема и неработающий manual restore пример; qualification index. Исторические failures сохранены. Source of truth — ROADMAP, новых Phase нет. [Полный продуктовый контракт](../../local-release-baseline.md), [changelog](../../../CHANGELOG.md).

Первый PostgreSQL запуск дал67/68 из-за ECONNRESET проверочного моста с малой listen backlog; увеличение backlog до128 привело к68/68 и825/825. Первый schema regression harness не задавал fixture DB_USER/DB_NAME; исправлен, все случаи повторены. Ошибки инструментов не выданы за продуктовые PASS.

## Итог локального release gate

**PASS**. [Сводка](gates.json), [secret scan](secret-scan.json), [независимый review](independent-review.md): **ACCEPT**, нерешённых CRITICAL/HIGH0, материальных противоречий0. Scan staged/outgoing:277 уникальных blobs,20 исходящих commits/25 staged files, включая summary/review записи; реальные private runtime/dev credential values, private key/GitHub/OpenAI/JWT patterns не найдены. Review дополнительно проверил AWS/token candidates и fixture-only literals. Pattern/value scan не является обещанием обнаружить любой неизвестный секрет. Raw лог summaries/хеши сохранены; приватные журналы проверены независимым агентом и не опубликованы.

`git diff --check` и staged check PASS. Повторные полные backend825/PostgreSQL68/frontend218 после итоговых changes PASS; quality logs подтверждены независимым review. Регрессию restore повторили после BASE TABLE fix; изменение views не принимается за известную base table. Новые API/backend/frontend app изменения не вводились; source remediation ограничена restore schema gate.

Этот checkpoint фиксирует готовность **локального prerelease** к разрешённой публикации. Перед push обязательна новая сверка origin/main без force/rebase; точный remote branch/tag и статус GitHub Release проверяются после публикации. Repository snapshot не утверждает, что эта внешняя публикация уже выполнена. Production gate остаётся NO_GO.
