# Граница root для TEST installer

Код в checkout не может сам стать своей доверенной точкой входа: подменённый
wrapper выполнится раньше встроенной проверки. Единственная разрешённая точка
входа для ограниченного sudo/systemd — отдельная проверенная копия
`deploy/linux/root-boundary.py`, установленная оператором в
`/usr/local/sbin/homecloud-test-launcher` с владельцем root и режимом 0755.
Запуск: `/usr/bin/python3 -I -S /usr/local/sbin/homecloud-test-launcher ACTION`.
Нельзя разрешать sudo к wrapper/Python-файлам в checkout, произвольным аргументам
Python, shell, Git, Docker или смене окружения. Старые sudoers/systemd entrypoints
требуют отдельного аудита и замены оператором; эта правка их не устанавливает.

Launcher перед любым исполнением checkout проверяет:

- всех владельцев и права цепочки `/home/hs/homecloud-test`, включая `/home/hs`;
- дерево `deploy`, `scripts` (включая untracked Python-зависимости), `.git` и
  Compose-файлы: root, отсутствие записи group/other, symlink, hardlink файлов,
  POSIX access/default ACL;
- отсутствие внешних Git objects/commondir/grafts; локальный Git config по
  разрешённому списку, HTTPS GitHub origin; запрет hooks/fsmonitor, внешнего
  config и replace objects при операциях installer;
- отдельный root-owned каталог `/etc/homecloud-test/docker` и его содержимое.
  Это единственный Docker client config; пользовательский `~/.docker` не читается.

Если `/home/hs` принадлежит hs, запуск **блокируется**, даже когда сам checkout
принадлежит root. Автоматически менять владельцев домашнего каталога нельзя:
это отдельное эксплуатационное решение с последствиями для существующего входа.
Launcher не исправляет права и не доверяет флагу окружения. Root shell/произвольный
sudo и доступ пользователя к Docker socket находятся вне этой модели: они уже
дают root-equivalent полномочия.

До запуска `backup.sh` отдельно проверяются внешний recovery config root:0600,
точная тройка квалифицированных Compose-файлов, совпадение параметров runtime,
каталог BACKUP_DIR root:0700 и все существующие объекты внутри него. Небезопасные
staging/markers или symlink отклоняются до очистки и записи резервной копии.

`UPDATE_INSTALL_BRIDGE_ENABLED=false` сохраняется. На Linux отдельно требуется
проверить реальные ACL/владельцев, наличие системных `/usr/bin/python3`, Git,
Docker/Compose, конфигурацию Docker, установленную копию launcher и sudoers,
включая отказ при подмене файла/каталога и зависимости. Пакеты ОС, root-controlled
Python stdlib и Docker plugin должны быть квалифицированы оператором.
Изменение на macOS не подтверждает эту эксплуатационную проверку и не выполняет
никаких действий на мини-ПК.
