# Воспроизведение evidence и границы повторного запуска

Runtime выполнял владелец вручную, один раз, SHA-verifying v2 launcher после scoped
security review. Recovery own-loop8 → fresh isolated root ext4/XFS run завершились rc0.
Exact frozen sources и manual conditions в [предыдущем checkpoint](../failed-run/manual-run-v2.md),
actual result/journal/recovery в текущем каталоге. Source SHA совпал до/после runtime.

Безопасная offline проверка с Mac из repo:

```sh
python3 docs/evidence/mount-identity-r2-1b-20261011/runtime-v2/verify-runtime.py
```

Verifier читает original baseline из parent и frozen actual evidence, записывает только
runtime-verification.json. Не делает SSH, root entry, loop/mount/Docker mutations.
Expected **95 checks PASS** при неизменных артефактах. Gate остаётся BLOCKED.

Read-only snapshot/cleanup собраны `collect-v2-run.py` и `check-cleanup.py` по strict SSH
host key/BatchMode. Collector source сохранён для аудита; collection directory exclusive
и при повторе нужно локальное новое имя. Старые runtime outputs/images сохраняются.
Повторять root launcher этого RUN нельзя: он требует fresh output/DATA, recovery
loop8 уже unbound и поэтому должен safe-stop. Для нового runtime требуется новый
reviewed exclusive RUN с current isolation/resources/ownership proofs; нельзя просто
менять constants, force flags, reuse loops или удалять fixtures ради обхода guards.

PASS FS строки не распространяются на default-seccomp/CAP-drop Docker workloads,
container recreation на XFS, host physical remount, reboot/power loss, clones/physical
uniqueness или complete host attestation. Trusted host/kernel/quiescent operator
предполагаются; privileged host adversary вне модели. Production остаётся NO_GO,
secureOpen=false, extra workspaces disabled; R2.2/MS-4 не начинать.


Дополнительная offline проверка native non-root supplier/Docker mapping:

```sh
python3 docs/evidence/mount-identity-r2-1b-20261011/runtime-v2/verify-rprivate.py
```

Expected36PASS. Non-root runtime выполнял run-rprivate-probe.py через exact reviewed
in-memory SHA; own project/DATA exclusive. Повторный runtime того же RUN запрещён:
не удалять control/results для обхода collision. Frozen probe/source/reviews/results
сохранены, его Docker CMD/namespace изоляция/cleanup видны в actual artifacts.
Tmpfs4MiB проверяет source namespace distinction, не XFS handle или live daemon-host
mount mutation. Два own normal containers удалены; дополнительный root вход не нужен.

Frozen collector сохраняет пути исходного workspace artifacts/r2-1b/preflight.py;
это audit source выполненного transport, не standalone installed CLI. Для повторного
read-only сбора сначала задают новое локальное место хранения и reference source;
рекомендуемые команды выше — только self-contained offline verifiers.
