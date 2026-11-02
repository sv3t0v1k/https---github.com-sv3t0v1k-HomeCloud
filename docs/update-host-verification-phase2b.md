# Phase 2B — независимая read-only проверка хоста

Отдельная точка входа: `deploy/linux/update-host-verify.py`. Admission не изменён:
`VALIDATION_REQUIRED` остаётся терминальным статусом. Verifier не записывает receipt,
не удаляет request, не вызывает установщик, Docker, SSH, backup, rollback или systemd.
Вывод `HOST_VERIFIED_READ_ONLY` — результат проверки в данный момент, не разрешение установки.

## Граница доверия

Будущая установка anchor — отдельная ручная квалификация; в этой фазе ничего не
развёрнуто. Anchor должен находиться вне checkout по фиксированному пути
`/usr/local/sbin/homecloud-update-verify`, root-owned, без групповой записи/ACL.
Команда после отдельного provisioning: `/usr/bin/python3 -I -S /usr/local/sbin/homecloud-update-verify`.
Shebang `-IS` также требует isolated Python без site-packages.
Checkout фиксирован: `/home/hs/homecloud-test`; применяется существующий root boundary.

Anchor закрепляет SHA256 шести helpers и компилирует исключительно проверенные
байты. Checkout не добавляется в sys.path; untracked Python не используется для
поиска импортов. Обновление helpers требует независимого review, обновления pins
и отдельного provisioning anchor. Сам целевой коммит никогда не является источником
исполняемого Python. Деревья deploy/scripts целевого и доверенного коммитов должны
совпадать; целевые helpers дополнительно сверяются с pins. Новые модули в этих
деревьях также требуют квалификации.

Заявка читается один раз существующим admission reader (NOFOLLOW, ownership, mode,
length). GitHub token берётся только из окружения процесса; CLI не принимает его
аргументом и выдаёт фиксированное сообщение при любом отказе. API и artifact
используют существующий bounded client, artifact storage не получает Authorization.
GHCR redirects удаляют Authorization; token response теперь ограничен по размеру.

## Проверки

- Точная структура заявки и TEST manifest, canonical SHA256 и фиксированный repository.
- Protected TEST HEAD, успешный push CI workflow/run/attempt, точный artifact.
- source_files, полный список миграций, class names и SHA256 читаются из Git blobs
  целевого коммита через ls-tree/cat-file, без checkout/worktree/clone/fetch.
- Symlink/submodule вместо файла отклоняется; blob ограничен 16 MiB.
- Оба GHCR index digest, platform digest, statement digest и существующая
  BuildKit mode=max проверка. Новый source_reader в provenance.verify получает
  Dockerfile, images.lock.json и images.platforms.json из целевого коммита.
  Прежние вызовы provenance.verify сохраняют прежнее поведение.
- После GHCR повторно проверяются все GitHub evidence; затем root boundary,
  helper pins и неизменность локального HEAD. Любая ошибка означает отказ.

Отсутствующий локальный target object или сеть — STOP. Verifier не скачивает Git
objects и не пытается исправлять окружение. Будущий worker обязан повторять всю
проверку перед действием; результат этой фазы не устраняет последующие гонки.

## Независимый security review

Выявлены и исправлены:

1. P1: самосогласованный manifest мог разрешить изменённый target host helper.
   Добавлены tree gate, pin gate и негативные тесты. Это был обход qualification
   policy, не исполнение target-кода.
2. P2: shebang не включал обязательный -S. Исправлен на -IS.
3. P2: существующий GHCR token endpoint читался без лимита. Добавлены лимит,
   проверка типа/длины токена и тесты oversized/null/whitespace.

Ограничение: BuildKit provenance остаётся UNSIGNED. Проверка digest/subject/VCS/
Dockerfile/base materials не является криптографическим доказательством того,
что всё содержимое образа построено из заявленного исходного коммита. Доверие
опирается на protected TEST, GitHub CI/artifact и registry. Установка не разрешена.

## Проверка реализации

- Исходные Phase 2 evidence/source/admission: 16 + 9 + 5 = 30 PASS.
- Host verifier: 16 PASS; provenance: 11 PASS.
- Широкий прогон 41 Python test suite: после предоставления localhost доступа
  scheduled-operations и задания HOMECLOUD_TEST_ROOT для preflight все наборы
  прошли; recovery-storage имеет 3 skip, scheduled-operations — 1 skip.
- Frontend: 27 suites / 325 PASS. Backend Updates: 5 suites / 27 PASS.
- Полный backend unit-профиль запускался на macOS: есть падения Linux-only
  secure filesystem и HTTP upload-тестов; Jest оставил открытые handles и был
  завершён после результата. Это блокер полной зелёной регрессии, а не PASS.
- Backend/frontend lint: PASS (backend: 20 предупреждений); обе сборки PASS.
- Live GHCR/GitHub и Linux root provisioning не выполнялись. Нужны отдельная
  квалификация и Linux CI до PR/следующей фазы. Mini-PC не затронут.
