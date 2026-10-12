# Воспроизводимый браузерный SSD fixture

Ожидаемое размещение этих файлов: `backend/test/frontend-ssd-browser/`. Корень репозитория вычисляется как `../../../` от этой папки. Единственный рабочий каталог задаётся абсолютным `HOMECLOUD_BROWSER_WORKDIR` **вне репозитория**. Туда заранее помещают `candidate-dist/` и `baseline-dist/`, затем туда записываются собственный private manifest, публичные результаты и снимки экрана.

Требуются Docker на Mac, образы `homecloud-stage24-candidate:arm64` и `postgres:16-alpine`, Node.js, Playwright и установленный Chromium. `HOMECLOUD_PLAYWRIGHT_DIR` задаёт путь к Playwright; стандартный путь соответствует bundled runtime Mac, на котором выполнен исходный прогон. Native backend модуль берётся из указанного тестового образа; текущие tracked backend TypeScript sources из `backend/src` компилируются внутри временного контейнера. Исходные файлы подключаются только для чтения.

После frontend targeted/full/lint/build проверок скопировать **содержимое** проверенного `frontend/dist` в `$HOMECLOUD_BROWSER_WORKDIR/candidate-dist`. Baseline для этого этапа — `cbeca1d04ab543def8273bd7749d3458f3e5a362`. Извлекать только tracked frontend-файлы, без полного archive и без untracked. Пример безопасного извлечения в собственный временный каталог:

```python
import os, pathlib, subprocess
ref = 'cbeca1d04ab543def8273bd7749d3458f3e5a362'
work = pathlib.Path(os.environ['HOMECLOUD_BROWSER_WORKDIR'])
target = work / 'baseline-source'
paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', ref, '--', 'frontend/']).decode().splitlines()
for name in paths:
    if not name.startswith('frontend/'):
        raise RuntimeError('Unexpected baseline path')
    output = target / pathlib.PurePosixPath(name).relative_to('frontend')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(subprocess.check_output(['git', 'show', f'{ref}:{name}']))
```

Установить зависимости baseline по его lockfile, выполнить baseline проверки и build, скопировать проверенный `baseline-source/dist` в `$HOMECLOUD_BROWSER_WORKDIR/baseline-dist`. Ни один тестовый static каталог нельзя удалять и создавать заново, пока он подключён к контейнеру: обновлять содержимое либо перезапускать только собственный fixture и обновлять его порты.

```sh
export HOMECLOUD_BROWSER_WORKDIR=/private/tmp/homecloud-browser-own-run
node backend/test/frontend-ssd-browser/start.cjs
node backend/test/frontend-ssd-browser/browser.cjs
node backend/test/frontend-ssd-browser/cleanup.cjs
```

`start.cjs` создаёт только uniquely named временные PostgreSQL/backend контейнеры, Docker network, SSD volumes и схемы. HDD расположен в overlay контейнера, SSD — в отдельном volume; `stat.dev` обязан различаться. SSD ON действует только в одном тестовом процессе. Во втором SSD OFF. Preview, мини-ПК, чужие контейнеры и volumes не используются.

Контролируемые busy/capacity HTTP503 ответы инъецируются middleware только собственного backend-процесса; это проверяет реальную браузерную реакцию на HTTP503. Postcommit HTTP500 возникает после настоящего durable store commit. Тест проверяет автоматический GET completed, UI completed, два complete POST для ограниченного идемпотентного cleanup replay, отсутствие DELETE, один файл и однократное увеличение квоты. Baseline-контекст получает отдельный fixture cookie и неизменённый baseline frontend из собственного backend static handler; его SSD ON admission обязан вернуть 400 из-за отсутствующего whole digest.

`fixture-private.json` содержит эфемерный control key. Его нельзя доставлять или коммитить. Cleanup проверяет точный собственный ID, удаляет только перечисленные собственные ресурсы, записывает публичный cleanup отчёт и удаляет private manifest. Публичный `browser-e2e.json` не содержит токенов и паролей. При неуспешном прогоне сохраняются предыдущий JSON и снимок ошибки. Не повторять идентичный неуспешный подход больше двух раз; сначала установить причину.

Этот тест использует небольшие payloads: он не квалифицирует 50+ ГиБ, RSS, физические SSD/HDD, power loss или эксплуатацию на мини-ПК. Исходный успешный прогон выполнен файлами `evidence/executed-server.cjs` и `evidence/executed-browser.cjs`; packaged вариант отличается только размещением путей и обязательным внешним workdir, поэтому не заявляется побайтово исполненным оригиналом.
