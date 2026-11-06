# GS-1B — реализация и проверка

Подготовлено к приёмке владельцем; **merge GS-1B не выполнялся**.
Дата: 7 ноября 2026, Asia/Vladivostok.
Кодовый checkpoint: `a10aa06835dd8aeddbb706eb2e586e13732efb4b`.
Ветка: `глобальный-поиск-gs1b-интерфейс`, база test `22e51dd3feb9ba470a4003576082eb2f559b8e5c`.
Итоговый HEAD документации и CI проверяются в отдельном PR GS-1B.

## GS-1A и Git

Перед merge PR #35 повторно подтверждены base=test, точный HEAD
`d071ad9cec73ba3ff4a49a1775f591eb23ec6418`, required check
`ci-v2-fast-terminal` PASS, отсутствие новых comments/review threads/reviews.
Merge выполнен с защитой expected head; результат повторно проверен как MERGED.
Merge commit: `22e51dd3feb9ba470a4003576082eb2f559b8e5c`.
Локальный test обновлён только fast-forward; из него создана рабочая ветка GS-1B.
Только объединённая ветка GS-1A удалена локально/origin; остальные ветки сохранены.

Единственный checkout — `~/Desktop/HomeCloud`; worktree/клонов нет. Три старых
untracked файла closure-checkpoint.json, closure-controls.json и
PHASE-5.3.1-TEST-AUDIT.md не изменялись и не включались. Изменений backend,
Docker, обновлений и пользовательских серверов в GS-1B нет.

## Реализация и автоматические проверки

[Контракт frontend](../../global-search-gs1b.md) описывает ввод, URL, запросы,
путь, пагинацию, клавиатуру, состояния и границы. План `.runtime/gs1b/plan.md`
использован с уточнением: обязательный полный путь реализован по раскрытию
одного результата, без фонового обхода дерева всей выдачи.

Порядок проверок: targeted → полный frontend → lint → build. После найденных
браузерных дефектов повторены соответствующие regression и полный набор.

| Проверка | Результат |
| --- | --- |
| Полный frontend | **402/402 assertions, 33 test files, skipped0, PASS** |
| Frontend lint | PASS, ошибок/предупреждений нет |
| TypeScript + Vite production build | PASS |
| Safe URL/query/pagination/Retry-After | searchApi.test.ts |
| Cache/owner/generation/abort/late response/StrictMode/400401429503 | useGlobalSearch.test.tsx |
| App/API/URL/page/preview/lazy path/XSS/errors | GlobalSearchPage.test.tsx |
| Login roundtrip/queue persistence/shortcut/located & stale row | SearchWorkspace.test.tsx |
| Authenticated login redirect race | LoginPage.test.tsx |
| Path cache/TTL/cycle/depth/abort/invalid metadata/403404 | searchPath.test.ts |
| Независимый финальный review | PASS, самостоятельные targeted44/44 |

Новые tests работают с реальными App/MemoryRouter/SessionProvider/apiClient,
существующей UploadQueue и тестовым HTTP adapter; это не live PostgreSQL.
Реальные HTTP/PostgreSQL/browser проверки выполнены отдельно ниже.
Raw локальные reports находятся в ignored `.runtime/gs1b`, без credentials в Git.
Полный Linux CI итогового PR должен оставаться успешным перед его объединением.

## Изолированная интеграция

Только synthetic данные: временный PostgreSQL15/schema gs1b_qa и loopback Nest
API3101 + Vite5175. Использованы compiled реальные AuthModule, UsersModule,
FilesModule, PreviewsModule, TypeORM, JwtGuard/JwtStrategy, production middleware,
validation, error filter/envelope и SQL из принятого GS-1A.
Два пользователя, 34 видимых совпадения, mixed pages, глубокая цепочка,
deleted/legacy-no-mirror/foreign fixtures, реальные текстовые файлы.

HTTP smoke:

- Без JWT —401; invalid query —400.
- Первая страница: 2 папки +18 файлов, hasMore=true.
- Вторая: 14 файлов, hasMore=false.
- Чужие записи, потомки удалённой папки и legacy без зеркала отсутствуют.
- Настоящий preview возвращает исходный текст; ancestor API возвращает путь.
- Native download prepare → HttpOnly capability → original bytes: PASS.
- Настоящий ACCESS EXCLUSIVE lock files → HTTP503 за2011ms → release →200.

Единственная заглушка integration runtime — GET /uploads/sessions →[];
upload operations этим runtime не квалифицируются. Сохранение реальной очереди
и её manager при route changes дополнительно покрыто frontend integration test.
Тестовый control.json допускает изолированную инъекцию400/429/503/задержек;
эти controls не входят в product и не ослабляют штатный limiter.
Секреты случайные, disposable, только ignored0600 config; в evidence не копируются.

## Браузерная QA

Проверен встроенный Chromium-браузер на настоящей локальной связке API/БД:

| Сценарий | Фактическое наблюдение |
| --- | --- |
| Поиск, Enter, URL | q появляется в адресе, 20 строк mixed выдачи |
| Страница2 и browser Back | offset20, диапазон21–34, Next disabled; Back возвращает cached страницу |
| Возврат из папки | Восстанавливаются query, scroll и фокус исходного результата |
| Полный путь | Мои файлы → Проекты → Архив →2026→Дом — ремонт→файл; только выбранная цепочка |
| Preview/Escape | Реальный текст документа, focus внутри; Escape возвращает focus имени |
| Показать в папке | Загруженная строка выделена, checkbox выбран, имя в фокусе |
| Перемещённый объект | Реальный move synthetic файла после выдачи → сообщение «Расположение изменилось…» |
| Ctrl+K из папки | Route поиска и focus global-search-query |
| 400 | Инъекция HTTP400: безопасный текст, «Изменить запрос» фокусирует input |
| 429 | Инъекция HTTP429/Retry-After2s: input сохранён, submit/retry временно disabled |
| Настоящий SQL503 | 25-секундная fixture lock: интерфейс показывает безопасную ошибку; manual retry после release успешен |
| Нет polling503 | Число search requests не растёт в idle; повтор только кнопкой |
| Реальный401 | Деактивация synthetic owner → auth/refresh fail → «Сессия истекла»/login |
| Login после401 | Повторный вход возвращает q=«Дом — план» и фактический файл; race устранён |
| Другой owner | Только его один документ, старой выдачи/путей первого owner нет |
| XSS fixture | Имя с img/onerror отображается текстом, img узлы не создаются |
| 320/390/768/1440px | document scrollWidth<=innerWidth на всех размерах; 320px targets>=44px |

Найденное переполнение topbar на320px исправлено и перепроверено. Во время
возобновления работы остановился только временный QA API; он перезапущен на той
же synthetic БД. Ошибка недоступного upstream корректно отображалась как server
error; продуктовый код ради fixture не менялся.

Браузерные скриншоты содержат только synthetic имена:
[desktop выдача](desktop-results.png), [полный путь](desktop-path.png),
[320px](mobile-320.png).

Ограничения QA: отдельные Safari/Firefox, физический touch device, фактический
screen reader и browser zoom200% не запускались. Проверены DOM/ARIA/focus,
реальная клавиатура и responsive viewport; это не заменяет названные проверки.
Устойчивость под произвольной конкурентной нагрузкой этим frontend этапом
не сертифицируется. Путь длиннее256 уровней требует отдельного UX решения.

## Решение перед merge

[Независимый read-only review](security-review.md) — PASS на кодовом checkpoint.
Frontend и backend взаимодействуют через принятый GS-1A API, backend не менялся.
MemoryStore сохранён; порог12 поисков/мин учтён явным submit/cooldown/cache.
Временные QA процессы после проверки останавливаются; пользовательские серверы
не использовались. Merge GS-1B и обновление серверов — только после отдельного
подтверждения владельца.
