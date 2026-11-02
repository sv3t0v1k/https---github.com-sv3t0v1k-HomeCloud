# Phase 3.1 — qualification checkpoint (2026-11-03)

## Protected TEST pair

- PR #20 merged into `test` at `b6ddfbde70fa52eea34ab19ffe93e8c7bb1e8986`.
- [Post-merge run 41537131477](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41537131477): all nine jobs succeeded, including backend, frontend, configuration, secrets, terminal gate, both TEST image publications, and pair creation.
- Artifact `test-channel-1`, ID `13185365716`, ZIP SHA256 `92b82be3346b56339369584d6f7255ed212283407ad262f016454658655627ee`. Downloaded JSON passed `scripts/ci/test-channel.py check` on exact TEST checkout. Its canonical `manifest_sha256` is `7bb3ebe922aa8c167b716dec6eef5e14ed9f3391801f2a22f627a4a0d8dff5e9`; file SHA256 is `d74cb9d346fb52481bd9376765cf93334e5ccab259d951592473d7d6050f3409`. It lists 30 source-checked migrations.
- GHCR index digests: backend `sha256:9dcacd2a97a0be55c4cc7d85a0fb2a69f3584b5b41c23a2afd38833784240dfa`; frontend `sha256:4e05942911b0bfad1ece89aa10693696d83f469c493e542fd86726c9b469e0aa`. Platform digests: backend `sha256:ae68f73e079fd80606af9ded8a580ec88e1abe8e5d5f483d6413510b29e97053`; frontend `sha256:7b68041199ed92936cb583d82aba0d3d8188640b983401764ee5578a86323a71`. Statement digests: backend `sha256:90ab6ba438066b919910b44ef1c087ed2cda7dc663e8687cb3d7247bd839a6ec`; frontend `sha256:b93e487f69ab80143546081a6ffd33d5c615783ba3b98bcdf47214354576c924`. CI's provenance verifier accepted both as `DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS`; signature remains `UNSIGNED`.

## Operational E2E verdict

| Scenario | Result | Evidence / limitation |
| --- | --- | --- |
| Exact TEST artifact, source, migration inventory and CI pair | PASS | Downloaded artifact checked at protected HEAD; post-merge CI and image publication succeeded. |
| Temporary PostgreSQL/files backup verifier and restore | PASS, limited | [Phase 3 host drill 41533517666](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41533517666) used real disposable PostgreSQL, exact `verify_backup()`, restored rows and file bytes, and rejected corruption. Artifacts were synthesized; `backup.sh` was not executed. |
| Initial installed images, migration compatibility, `backup.sh`, Compose switch, backend/frontend/HTTPS and final checkpoint | BLOCKED | No isolated host satisfying the unmodified physical disk preflight and initial installed checkpoint was available. No live installer apply occurred. |
| Failure before backup, after service stop, migration error, health failure, SIGKILL, timeout/lost acknowledgement, repeated install, rollback and data recovery | BLOCKED | Existing process/contract tests are synthetic; no actual switched containers or post-failure PostgreSQL rows/files were verified. `ROLLED_BACK` is not claimed. |
| Full worker E2E | BLOCKED | `PROVISIONED=False`; Compose keeps `UPDATE_INSTALL_BRIDGE_ENABLED=false`. Worker must remain disabled. |

The installer itself has a further independent gate: `precheck_source()` compares the complete installed and target `deploy` and `scripts` Git trees before any pending transaction. For `40f11e2 → b6ddfbd`, `deploy` changes from `fc996263457c1f055ece2f77549ab3bf14f570cf` to `162d9b1ab98e0dfbcc8369f93691779e3034a36f`, and `scripts` from `7cde77ae26bc98410feb9fc2eecb3383abcc47e3` to `892f041d9a1ff7585c38f07d9d24aa4ba67c4be1`. A real apply from the prior checkpoint therefore stops before backup. The Linux preflight also requires two distinct physical ext4/xfs disks with matching UUID, serial and WWN; an ordinary GitHub-hosted runner is not a valid host. Neither gate was bypassed.

An independent review covered root ownership, Docker privileges, credentials, TOCTOU, path confinement, durable state and recovery. It found no confirmed exploitable defect. Recovery before target start retains `pending.json`; after target start, automatic rollback is unavailable and requires operator reconciliation with data checks. A readiness race in the disposable backup-verification PostgreSQL was corrected by waiting for init completion and three successful SQL probes, as the earlier real Phase 3 drill demonstrated that `pg_isready` alone can accept the temporary init server.

The first Phase 3.1 PR host drill ([run 41538661758](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/41538661758)) stopped before backup because its workflow still requested the previous TEST manifest identity. This was a stale test fixture; the workflow now requests the exact protected `b6ddfbd` identity above. That failed run supplies no backup or installation PASS.

Operational acceptance remains **BLOCKED**. Before enabling installation, qualify a trusted initial checkpoint and helper-tree transition on an isolated host meeting the physical disk gate; then execute `backup.sh`, real image switching, fault injection and restore with row/file/container/migration/checkpoint comparison. Do not enable the worker or bridge based on this checkpoint.
