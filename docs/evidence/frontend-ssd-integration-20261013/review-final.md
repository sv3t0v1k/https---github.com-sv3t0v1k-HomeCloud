# Независимый review Frontend SSD Integration

Дата: 13 октября 2026, Asia/Vladivostok. Reviewer: отдельный агент critical_review.

Статус: критичный frontend и окончательный browser evidence проверены; открытых MUST_FIX на этом этапе не осталось. Новый browser прогон после исправления cleanup barrier: 14/14 PASS. Проверку удаления собственных Docker-ресурсов отдельно завершает основной исполнитель. Это не статус COMPLETE и не разрешение испытаний мини-ПК.

## Независимость и метод

Reviewer не писал production-код. Единственные написанные reviewer тесты находятся в `frontend/src/files/ssdRetry.test.ts`; reviewer выполнил их, но не представляет собственное авторство тестов как независимый review самих тестов. Production-файлы проверены статически по фактическому коду, контрактам backend и последующим исправлениям другого исполнителя. Git и Docker reviewer не менял. Запрещённый аудит не читался, не искался, не хешировался и не менялся.

## Выявленные и устранённые риски

1. Pause во время admission 503/429 backoff сохранял ложный `creationUncertain`, блокируя безопасное Resume. Теперь неопределённость устанавливается перед каждой фактической попыткой и снимается при определённом отказе до ожидания. Это проверено статически; соответствующий интеграционный тест другого исполнителя присутствует в окончательном targeted наборе.
2. Ошибка GET receipt могла заменить исходный complete 503 и потерять Retry-After. Теперь helper сохраняет и повторно выбрасывает исходную ошибку. Reviewer тест проверяет отсутствие POST replay до обязательных 1000 мс при GET network failure.
3. Предварительное заключение «нет критичных замечаний» было неполным и заменено этим отчётом. Во время проверки evidence основной исполнитель обнаружил `committed / cleanupState=pending`. Независимая проверка подтвердила: миграция `1746825190000` задаёт глобальный unique slot по `cleanupState='pending'`; GET completed receipt не запускает recovery; следующий complete POST запускает cleanup. Поэтому одного опубликованного File недостаточно для окончания frontend-финализации. Helper теперь сверяет receipt, сохраняет известный File и требует ограниченный идемпотентный complete POST replay. Resume со completed GET также запускает replay. Старый browser результат с 12 PASS не доказывает освобождение этого барьера.
4. Replay после неудавшегося Cancel мог наследовать 30-минутный timeout. Теперь cancellation reconciliation имеет общий таймер, AbortSignal, deadline и оставшийся timeout для GET + POST replay. Известный File сохраняется при ошибке. Reviewer тест со действительно зависшим, реагирующим на AbortSignal POST подтверждает завершение попытки за 5000 мс, один POST и отсутствие оставшихся таймеров.

## Проверки reviewer

`ssdRetry.test.ts`: 5/5 PASS. Проверены сохранение Retry-After, положительный jitter 300/600 мс, общий бюджет ожидания, отказ вместо раннего retry при Retry-After 61 с, недостаточном оставшемся бюджете и ограничение cancellation receipt replay. TypeScript `--noEmit --incremental false`: PASS.

Окончательные машинные результаты независимо прочитаны: `targeted-final.json` 114/114, `candidate-frontend-final.json` 278/278. `baseline-comparison-final.json`: baseline 218, unchanged 218, missing/changed пустые, 60 новых PASS. `checks-final.json` фиксирует lint exit 0 / warnings 0 и build exit 0. Промежуточный `baseline-comparison.json` с 275 тестами не используется как окончательный gate.

Whole SHA-256 проверен статически: чтение ограничено 2 MiB, вычисление разбито на 256 KiB, есть реальные task boundaries и отмена, длина кодируется через BigInt, whole-file ArrayBuffer не создаётся. Опубликованные вектора и синтетический 64-bit trailer проверяются отдельными тестами другого исполнителя. Это не квалификация 50+ GiB и не измерение RSS.

## Fixture и точность evidence

Подготовка использует случайный namespace, отдельные network / DB / SSD volumes, loopback-порты и read-only bind mounts. SSD включается только в тестовом процессе. Packaged cleanup предварительно проверяет точные разрешённые имена всех ресурсов, удаляет только их и допускает уже отсутствующие ресурсы; неожиданные ошибки сохраняются. Reviewer Docker-команды не исполнял.

Busy/capacity 503 вводятся middleware внутри disposable backend; это проверка реакции браузера, а не физической ёмкости или реальной конкуренции finalizer. Postcommit failure вводится выбросом ошибки после durable commit и представляет HTTP 500, а не доказанный разрыв TCP. Первый неудавшийся browser прогон сохранён отдельно и не является PASS. Окончательный `browser-e2e.json` относится к свежему fixture `hc-frontend-ssd-ad48b22e51`: success=true, 14/14 checks. Все 5 SSD receipts имеют committed/cleaned. Postcommit HTTP 500: два complete POST, ноль DELETE, один File и одно начисление +1024 байт; следующая обычная SSD-загрузка 1280 байт прошла UI completion, точное скачивание и Range 206. Busy: три попытки, фактические интервалы 1013/1023 мс при Retry-After 1 с; окончательный script требует минимум 1000 мс. Resume после reload сохраняет uploadId, Cancel подтверждён серверным aborted без File, capacity 503 не повторяется автоматически, legacy OFF не передаёт whole hash. Неизменённый baseline frontend на SSD ON получает admission 400 без новой session/File.

Ограничение backend-контракта: metadata GET не раскрывает cleanup state; обычный complete может вернуть File после best-effort cleanup с предупреждением в backend. Этот frontend этап не доказывает восстановление при произвольной постоянной ошибке cleanup. Нужны отдельный следующий gate и серверные evidence; backend здесь не изменяется.

## SHA-256 проверенного снимка

| Файл | SHA-256 |
| --- | --- |
| `frontend/src/api/errors.ts` | `ad9bb37d55b8e0dee3e5eb1ff6e13866e8c4d7d44026be0f9b34d861206c60b2` |
| `frontend/src/files/upload.ts` | `9e14d16e13919afc3c6064ec97bf58f818f4b203e54a7cb1c56a9fdf98369432` |
| `frontend/src/files/uploadQueue.ts` | `92aa6f73c1e2955b0706f79f6c1495f790f95804747030fb143d815793a1d163` |
| `frontend/src/files/wholeSha256.ts` | `e5efc833651a9b4fb6cde4329f00adc9d9d9319cd2a804c70c2f4951b1559f7f` |
| `frontend/src/files/FileBrowserPage.tsx` | `0c9c6eb4e3f0d9dd0d56f7ca1c9ad49a8c7765a2c2bd9839902bef2cdbded6a2` |
| `frontend/src/files/ssdRetry.test.ts` | `53a045294a80b94f4caa1f121aeff19dc078a40089439a00e146993a05506761` |
| `backend/src/uploads/ssd-uploads.service.ts` | `7cc0218798e5a4b1dbda9ce876f808c77e05e539988ce57ac8a74716365794ba` |
| `backend/src/uploads/ssd-finalization-store.ts` | `833a334537f8bd6b83ed8c3f65edc6ac3269a9c4bfd92dfa28eed31c77a94fdc` |
| `backend/src/migrations/1746825190000-SsdFinalizationRecovery.ts` | `5adb35ed454869663018418e5e5f7f931e27b05bebafb1bea9922e4a98b9f541` |
| `e2e/repo/server.cjs` | `b129cde9c06d30b4d638bef72c74042c4719c997869fec115dca22ed4ff72ddf` |
| `e2e/repo/browser.cjs` | `8673b66beed706303d8227e0e44193ff37e1ba2175fc7841d9519c1fb4c555be` |
| `e2e/repo/start.cjs` | `dc097a374bbde1b635cef864b7ae7d85b1beb303665c1f523215a3a543e5810a` |
| `e2e/repo/cleanup.cjs` | `5555f3231232a2dc1dd7c6462d9a79461f3d8308997ca625526cf7cdd1916477` |
| `e2e/server.cjs` | `b129cde9c06d30b4d638bef72c74042c4719c997869fec115dca22ed4ff72ddf` |
| `e2e/browser.cjs` | `0fd05d474e48d60d0ecb073b29ea7dbcabeed6dae3694ff2eb1ceef4ceeefe94` |
| `evidence/browser-e2e.json` | `86f235fe7566ec097b3a3b5786509a9e203d526a6bec76a4f2219a66679bb6d4` |
| `evidence/baseline-comparison-final.json` | `6dee1ef0dcc0d665b42e8d09e5769895fe40c8140ee627ef2bea7065291dd091` |
| `evidence/checks-final.json` | `50b4d44b22e6057b2384fb6c6b4a2d1fb1f15ef0bb6e8f4088885795c45ae3ba` |
