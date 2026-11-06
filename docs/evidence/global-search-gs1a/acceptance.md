# GS-1A — приёмочный checkpoint

**PASS — подготовлен к приёмке владельцем. Merge не выполнялся.**
Дата: 7 ноября 2026, Asia/Vladivostok.
Кодовый checkpoint: `fd4dbbcaf7d3b2e775f5b732aeb9e67fdd9b2457`.
Исходный HEAD этой работы: `00649fd9c0788baa92b4679be72282ed856079cc`.
База: `test`, `27e212fa6580f44655d8829d6003c7b39938f561`.
[PR #35](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/35),
ветка `глобальный-поиск-gs1a`.

## Что закрыто

Проверен весь GS-1A, а не только последний diff. Исходный scope восстановлен из
описания PR и его 11 исходных коммитов, предыдущих review на `7543808`, `1d8a14e`
и `00649fd`, текущего кода и тестов. На GitHub review threads/comments отсутствовали;
предыдущие заключения прочитаны в связанных чатах проекта.

| Исходный критерий / замечание | Результат |
| --- | --- |
| Валидация запроса, limit/offset | PASS, общий helper + HTTP negative cases |
| Буквальный поиск, SQL injection | PASS, bind parameters, ILIKE escape |
| Safe DTO без storage metadata | PASS, явная проекция обоих поисков |
| Owner isolation | PASS, owner на всех уровнях дерева и зеркал |
| Legacy-папки, отсутствующее/удалённое зеркало предка | PASS, всё недоступное поддерево исключается |
| Удалённые папки и потомки | PASS, real PG regression |
| Дедупликация, единая mixed pagination, стабильный порядок | PASS, LIMIT до split, name/id tie breaker |
| Стоимость рекурсии | PASS в пределах SQL budget: SET LOCAL 2000ms + rate limit |
| Обход лимита через Authorization | PASS, общий строгий parser |
| JWT на Passport и JwtGuard, active/deleted user | PASS, единая live validation |
| Старый GET /files?search= | PASS, общий SQL/budget, safe bounded array |
| Совместимость остальных функций | PASS, полный Linux backend/frontend CI |
| Независимый security review | PASS, HIGH/CRITICAL 0 |

Ресурсная защита не означает доказательство устойчивости под любой нагрузкой.
MemoryStore принят для одного backend. Listings без search не подвергались
общему изменению ancestry-политики. Подробные границы в [контракте](../../global-search-gs1a.md).

## Полный Linux CI на кодовом checkpoint

[HomeCloud PR Fast + Integration v2, run 93](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/42237812041):
**completed / success**. Проверены реальные job logs и fail-closed test-routing
verification, а не только зелёный общий значок.

| Проверка | Фактический результат |
| --- | --- |
| Backend unit | 64 suites, 1021/1021 assertions, skipped 0 |
| Integration/PostgreSQL 16 | 31 suites, 364/364 assertions, skipped 0 |
| Frontend | 27 suites, 328/328 assertions, skipped 0 |
| Backend ESLint | 0 ошибок, 20 прежних предупреждений |
| TypeScript + backend build | PASS |
| Compiled file-type/dependency/multipart runtime | PASS |
| Frontend lint/build | PASS |
| Configuration + secrets + terminal gate | PASS |

[Phase 3 host qualification and failure drills, run 37](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/42237812074):
**completed / success**. Это существующая изолированная CI-квалификация;
реальные пользовательские серверы не изменялись.

PostgreSQL performance из CI: 3081 папка, глубина 80, страница 50,
planning 1.051 ms, execution 20.455 ms, shared hit blocks 15392.
Это синтетическая диагностика, не обещание production SLA.

## Дополнительные локальные проверки и честные ограничения

- Targeted поиск: 3 suites, 50/50 PASS, включая реальный PostgreSQL 15 и HTTP.
- После последней DI/lint правки: 4 suites, 92/92 PASS (JWT, auth controller,
  HTTP search/limit), lint/typecheck/backend build PASS.
- Независимый повтор ревьюера на финальном кодовом HEAD: 4 suites, 99/99 PASS,
  включая реальную отмену обоих service searches по 2000ms и восстановление БД.
- Frontend: 328/328 PASS, lint/build PASS.
- Полный первоначальный macOS unit-прогон: 977 PASS / 44 FAIL; из них 38 отказов
  Linux-only filesystem/ingress/upload и 6 отсутствующих DI fixtures в
  auth.controller.spec.ts. Fixture исправлена, 6/6 повторно PASS. Из-за открытого
  сокета после platform failures процесс завершён после записи отчёта.
- Полный macOS integration-прогон: 257 PASS / 107 FAIL в четырёх upload suites,
  требующих Linux SecureFilesystem. Эти отказы не скрывались, тесты не пропускались
  и production-защита не ослаблялась. Обязательная полная квалификация выполнена
  на Linux CI выше, включая все эти suites.

Локальная БД была отдельным временным процессом с данными под `.runtime/gs1a`;
существующие БД/серверы не использовались. Raw локальные отчёты остаются в
ignored `.runtime/gs1a`, в Git их нет. Временная БД после проверки остановлена.

## Независимость и состояние Git

[Независимое заключение](security-review.md): отдельный агент, не автор кода,
read-only полный diff и собственный прогон. Verdict PASS, HIGH/CRITICAL 0.
Дополнительный аудит scope выполнен другим read-only агентом; его находки
проверены основным исполнителем по коду и воспроизводимым тестам.

Коммит исправлений — `fd4dbbc`; следующий коммит содержит только этот контракт
и evidence. Реализация GS-1B в PR #35 не включается. Финальный SHA документации
и его CI фиксируются в передаче владельцу и доступны в PR.

Единственная рабочая копия — `~/Desktop/HomeCloud`; worktree/клоны не создавались.
Три ранее существовавших untracked файла не изменялись/не добавлялись:
closure-checkpoint.json, closure-controls.json и PHASE-5.3.1-TEST-AUDIT.md.
Docker, механизм обновлений и серверы не изменялись. MemoryStore сохранён.
Merge и старт реализации GS-1B требуют решения владельца.
