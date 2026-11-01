# HomeCloud — TEST update job admission (Phase 1, disabled)

Status: **implementation draft for local review only**. No host service is deployed; no Docker installation is enabled. Do not enable `UPDATE_INSTALL_BRIDGE_ENABLED` on a live host until the separately audited host consumer is installed, host-side verification is completed and real failure/recovery drills pass.

## Backend boundary

- Authenticated admin-only endpoints: `POST /api/v1/updates/installations` (202) and `GET /api/v1/updates/installations/current`.
- POST accepts only `{ "manifestSha256": "<64 lowercase hex>" }` and **only** when TEST discovery has just returned a verified available build with the same manifest hash.
- `UPDATE_INSTALL_BRIDGE_ENABLED` must equal `true` (disabled by default); `UPDATE_CHANNEL` must equal `test`. RELEASE installation intentionally unsupported.
- Operator-supplied absolute `UPDATE_REQUEST_INBOX` must be provisioned in advance as a root-owned directory, no world permissions. Recommended root:65533 with 0770. Mount into backend **only this inbox**, read/write. The backend runs UID 1001 and GID 65533 in the existing Linux override.
- `UPDATE_STATUS_FILE` must refer to a root-owned, non-symlink regular JSON file no larger than 4096 bytes, with group 65533 and mode 0640. Bind-mount the dedicated host status **directory** read-only into backend, so atomic publication of `current.json` becomes visible; do not bind-mount the individual file. Do not mount installer scripts or other host job state into backend.
- Inbox is a *single-slot request file* named `request.json`. Submission writes an fsynced unique temporary file, then atomically publishes it using an exclusive hard link (`EEXIST` = 409 conflict). The backend cannot invoke Docker, systemd or privileged commands.
- Host consumer MUST independently verify manifest, source/provenance, current protected TEST branch, migration hashes and running images before installation. Neither backend's check result nor this queue is proof of trust.
- Host must read request once into protected root-owned state, handle truncation/mutation/symlinks safely, independently validate and remove or quarantine the inbox request. `systemd.path` and the installer worker must remain separately gated. The included `systemd.path` and read-only admission worker only validate the request and write a `VALIDATION_REQUIRED` receipt. They never install anything; the real install worker is a **later** stage.

## Host receipt (future contract)

```json
{"format":"homecloud-update-status-v1","status":"QUEUED","manifestSha256":"<64 lowercase hex>","phase":null,"updatedAt":"2026-11-01T00:00:00Z"}
```

Allowed status values: `QUEUED`, `RUNNING`, `INSTALLED`, `STOP`, `MANUAL_RECOVERY_REQUIRED`, `VALIDATION_REQUIRED`. The backend maps missing receipt to `NO_JOB` and invalid/unreadable receipt to `UNKNOWN_REQUIRES_REVIEW`. Every existing receipt, including `INSTALLED`, blocks another request until an operator reconciles and clears the host state. It does NOT infer success from container restarts or a missing job.

## Safety gates before enablement

1. Independent review of privileged host consumer, service file and root/group ownership.
2. Separate, safe local end-to-end tests for duplicate requests, altered manifest, concurrent submissions, process kill, power loss, unhealthy backend and migration mismatch.
3. Root-owned host agent validates supply chain and launches existing installer with bounded arguments. No SSH, Docker socket in backend or GitHub Actions deploy.
4. Verified backup and rollback protocol; current TEST installer requires manual reconciliation when `pending.json` survives a failure. Do not claim automatic rollback works yet.
5. Deploy only after explicit operator approval. Keep the mini-PC and Proxmox untouched for this phase.
