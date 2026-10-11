# Воспроизведение MS-3B-R2.1 research

Безопасная offline сверка имеющегося evidence из каталога этого отчёта:

```sh
python3 verify-evidence.py
```

Фактический remote запуск каждого исследовательского runner выполнялся следующим
способом. Код запускается на Mac из каталога evidence; `script_name` и `log_name`
соответствуют паре `run-research.py`/`research` либо `run-readonly-fd.py`/`readonly-fd`.

```python
import json, shlex, subprocess
from pathlib import Path

p = Path.cwd()
script_name = 'run-research.py'
log_name = 'research'
remote = 'python3 -c ' + shlex.quote((p / script_name).read_text())
payload = json.dumps({'source': (p / 'identity-probe.c').read_text()})
with (p / (log_name + '.ndjson')).open('w') as out, \
     (p / (log_name + '.stderr')).open('w') as err:
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
         '-o', 'StrictHostKeyChecking=yes', 'hs@192.168.3.44', remote],
        input=payload, text=True, stdout=out, stderr=err, timeout=300,
    )
print(result.returncode)
```

**Повторный remote запуск не разрешён этим документом.** Исходный RUN уже существует:
primary runner использует exclusive mkdir и должен отказать. До нового прогона нужны
owner-approved новые disposable paths и новые имена runner/container artifacts; требуется
сохранить прежние логи и выбрать новые локальные output filenames. Нельзя удалять прежние
или чужие fixtures для обхода collision. O_RDONLY follow-up требует results первого
runner, создаёт отдельный source через exclusive open и не заменяет исходный probe.

Фактически выполненные targeted tests, assertions и Docker flags находятся в двух runner
sources. Native compile, process/container restart, directory/marker copy/replacement,
реальный inode reuse, ordinary nested bind/NO_XDEV, read-only XFS root, overlay95,
UID1001 raw capability и O_RDONLY comparison — весь выполненный scope. Privileged namespace
unmount/remount, XFS writes, application integration и backend suites не выполнялись.

Следующий checkpoint потребует отдельного owner scope для отсутствующих qualification
сценариев. Не запускать production entrypoint, app images с дополнительными правами,
real mount changes, global prune, service restart или background workloads.
