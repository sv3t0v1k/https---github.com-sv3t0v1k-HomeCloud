# D5.1.13 — транспорт exact OCI без пересборки

Подготовлен `experiments/d5-1-13/artifact.py`; подключение к preflight выполняется отдельно. Это только чтение GitHub API/blob и проверка файлов. Docker, build, load, push, CI dispatch, SSH и публикация отсутствуют.

## Контракт и ограничения

`fetch_verified(download_dir, metadata, lock, verifier, total_timeout=600)` вызывается после существующего `validate_origin`. Каталог должен быть новым приватным каталогом задания; переданные metadata повторно проверяются на artifact ID, отсутствие expiry и закреплённый ZIP digest. Возвращаются `archive`, `candidate`, `identity`, `transport`. До возврата обязательно вызывается существующий `prepare.verify_archive(candidate, lock)` с проверкой SHA tar, OCI manifest/config/layers и linux/amd64. ZIP bytes не перекодируются; OCI не меняется.

Перед каждой из максимум двух transfer sessions получается новый HTTPS redirect URL. Токен остаётся в памяти; GitHub Authorization не отправляется blob-серверу. Redirect дальше не следует автоматически. Сохраняются только controlled error types и числовые данные сессии, без signed URL, query, token и текста upstream exceptions.

Пределы текущей версии: 600 секунд суммарно на получение URL и transfer; первый session ограничен 300 секундами, чтобы оставить второй session время для fresh-URL resume; socket timeout не более оставшегося бюджета/15 секунд; ZIP не больше 128 MiB, точная длина берётся из проверенного artifact metadata; распакованный единственный member `candidate.oci.tar` меньше 512 MiB. Файл назначения должен отсутствовать. Никакие посторонние файлы не удаляются.

При прерывании HTTP тело дописывается только при strong ETag, запросе `Range`/`If-Match`, статусе 206, точном `Content-Range` и совпавшем ETag. При ответе 200 на Range файл полностью перезаписывается с нуля в этой же сессии. Без strong ETag следующий запрос начинает полную загрузку. После transfer обязателен pinned ZIP SHA-256; при несовпадении нет ни автоматического retry, ни извлечения tar. Ошибка либо истечение двух sessions означает `NOT_VERIFIED`, а не разрешение пересборить образ.

## Первичные источники и границы гарантий

[GitHub REST artifacts](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact) описывает 302 download redirect, срок URL одну минуту, `zip` и минимальное разрешение Actions read. GitHub не обещает в этом API контракт поддержки Range. Поэтому resume проверяется по фактическому HTTP ответу, а не предполагается.

[Azure Get Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob) описывает Range, 206, Content-Range и ETag. [Azure conditional headers](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) описывает If-Match. Это объясняет условный механизм, но не доказывает поддержку конкретным GitHub backend; только валидный ответ принимается для продолжения partial bytes.

## Целевые локальные проверки

`python3 experiments/d5-1-13/test_artifact.py`: 15 tests PASS. Синтетические in-memory HTTP responses проверяют успешный transfer, strong ETag resume, игнорирование Range с полным restart, weak ETag, неверный Range/ETag, длину/кодирование/oversize, digest mismatch, два sessions, deadline и резерв времени для второго session, redaction ошибок, запрет overwrite, ZIP member allowlist, вызов существующего tar verifier и сохранение постороннего candidate, включая появившийся после первоначальной проверки во время transfer. Очистка собственного partial tar ограничена сохранённой при exclusive-create парой device/inode; чужой файл не удаляется. Docker и сеть для этих тестов не нужны.

## Remote evidence

Свежая read-only metadata проверка: artifact `12095095760`, run `39015752148`, 116311061 bytes, `expired=false`, retention до `2026-11-16T08:01:14Z`. Origin/build pins проходят существующий `validate_origin`; JSON сохранён в `raw/artifact-origin.json`. Первый подход (до доработки разделения времени между sessions), `raw/artifact-transport-result.json`: **NOT_VERIFIED**. Суммарный бюджет завершился за 420.002 секунды; получено 87556096 из 116311061 bytes. Реальный ответ первого transfer — HTTP 200, strong ETag присутствовал. Второй slot первого подхода не открыл HTTP transfer, поскольку общий deadline уже исчерпан. После анализа выполнен только один дополнительный bounded suffix-only подход в пределах read-only исследования, описанный ниже. ZIP SHA и tar verifier не выполнялись для неполного файла, runtime не запускался. Неполный ZIP оставлен только в приватном временном каталоге, не в репозитории/evidence upload.

## Второй и последний read-only подход: PASS

`raw/artifact-resume-result.json` и выполнявшийся helper `raw/artifact-resume-check.py` фиксируют **REMOTE_EXACT_OCI_VERIFIED** за 148.738 секунды при бюджете 180 секунд. Retained prefix до окончания полной проверки считался unverified. Получен новый signed URL; HEAD подтвердил длину 116311061 и strong ETag. Запрос suffix с `Range: bytes=87556096-` и `If-Match` вернул 206, точный `Content-Range: bytes 87556096-116311060/116311061` и тот же ETag. Только после этих проверок suffix дописан к retained prefix. Полная повторная загрузка не выполнялась и при ответе 200 была бы запрещена.

Полный ZIP теперь имеет 116311061 bytes и SHA-256 `c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83`. Existing `prepare.verify_archive` подтвердил exact manifest `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`, config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`, 14 layers и Linux/amd64. Проверка включала закреплённый tar SHA и OCI descriptor/blob hashes. Образ не менялся. ZIP и tar находятся только в `/private/tmp/d513-artifact-transport-gxw004ja`, без загрузки повторного artifact в GitHub.

Remote exact bytes и практический Range resume подтверждены; доступность будущей загрузки всё ещё зависит от retention, сети и бюджетов. Предположение, что hosted runner скачает быстрее локальной сети, не является evidence; будущий manual preflight снова обязан получить полный pinned ZIP и подтвердить tar identity до runtime. Фактический суммарный transfer/verification путь двух исследовательских подходов занял около 568.740 секунды (420.002 + 148.738), поэтому прежний default 420 секунд не покрывал наблюдаемое время на этой сети. Production default и жёсткий maximum повышены до 600 секунд с двумя sessions и первым slice 300 секунд; явный меньший бюджет 420 секунд продолжает поддерживаться. Это ограниченный запас по одному наблюдению, без обещания доступности или скорости будущей сети. Никаких дальнейших remote подходов в этой подготовке нет. При будущей повторной ошибке нельзя автоматически увеличивать бюджет или заменять OCI пересборкой.

Production NO_GO. PR draft. Medium/UNKNOWN не приняты. Provenance/SBOM UNSIGNED и reproducibility UNPROVEN сохраняются. Даже успешная transport проверка не даёт разрешения на runtime или production.
