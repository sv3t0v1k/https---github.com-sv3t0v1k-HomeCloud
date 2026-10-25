# CI Reset v2 — proposed contract (not approved)

Status: local implementation proposal. The existing `.github/workflows/ci.yml`,
`scripts/ci/policy-coverage.py`, security thresholds, and release gate remain
authoritative until the owner explicitly approves the policy change. A Fast
PASS is never a Security PASS or a production GO.
The proposed `.github/workflows/ci-v2-fast.yml` has only `workflow_call` and
does not start on PRs. Its PR trigger must be activated in the same approved
change that removes the old PR trigger; publishing both triggers would double
the work. The pair binding is already added to the qualification collector,
but the old dedicated `provenance-pair` job remains mandatory for the current
policy. Its removal is pending approval of the replacement environment set.
The dormant `ci-v2-security.yml` calls the existing complete qualification and
checks that the PR HEAD/base have not changed. It deliberately retains the
old scans and even reruns Fast/Integration once for the final candidate. It is
a compatibility bridge, not the final optimized Security Qualification.

## Required checks

| Check | Every PR HEAD (Fast) | Integration | Final candidate before merge (Security Qualification) | Release |
| --- | --- | --- | --- | --- |
| Backend/frontend lint, backend typecheck, both builds | Required | — | Bound to same candidate | Required via qualification |
| All backend/frontend unit suites, critical auth/upload/share/SHA-256/ZIP/access smoke | Required; checked JSON, no skipped/empty suites | — | Bound to same candidate | Required via qualification |
| Routing, policy/release/provenance/scan negative tests, Compose/startup/preflight/recovery contracts | Required | — | Policy version bound | Required via qualification |
| PostgreSQL, migrations, concurrency, filesystem and all `bench/*.spec.ts` correctness suites | — | Required on every code PR; disposable PostgreSQL, unprivileged UID, writable and checked JSON, no skipped suites | Bound to same candidate | Required via qualification |
| Runtime and full/dev dependency audit, secrets | — | — | Required; raw HIGH/CRITICAL retained and current thresholds enforced | Required |
| Exact backend/frontend/postgres/ingress/buildkit OCI, dependency/builder stages, installed tooling, provenance and evidence closure | — | — | Required; archive/manifest/config/platform/source/digest/DB freshness bound | Required again for release profile |
| Hosted runner rootfs | — | — | Proposed periodic platform assurance; raw findings retained | Required when release policy says so |
| Publication environment, protected branch, tag and registry digest reconciliation | — | — | — | Required; publish qualified archives without rebuilding |

Fast and Integration results are separate, required checks. Neither may be
silently skipped. Security Qualification must be run for the final HEAD and
base SHA before merge, and must be repeated when either changes. Missing,
cancelled, stale, failed, unexpected skipped, or incomplete results block.
There is no cross-run PASS-verdict cache. Download/DB caches are permitted only
for inputs with verified integrity and freshness. Release accepts only its
own release-profile qualification from the same run/attempt.

The current private repository has no enforceable protected-branch checks.
Until protection is available, the owner must compare HEAD, base SHA, and
completed check identities immediately before merge and prohibit direct pushes
to `main`. This manual procedure cannot eliminate a race or an authorized
writer bypass. The existing release workflow requires `main.protected=true`;
that requirement is unchanged. Production remains NO_GO.

## Exact policy diff proposed for separate approval

| Current evidence / gate | v2 proposal | Safety condition |
| --- | --- | --- |
| Full `rootfs.json`, global npm, component and tools for each of 13 PR environments, including Fast and a dedicated provenance runner | Keep raw findings for completed scans; stop requiring duplicate host-rootfs scans for every Fast/Integration job. Run hosted rootfs periodically as `PLATFORM_ASSURANCE`. Qualify actually executed tools and installed dependencies in the qualification jobs. | The owner approves the new environment set and verifies inventory/ownership; an unknown or unscanned executed tool blocks. No HIGH/CRITICAL threshold changes. |
| Separate `provenance-pair` runner and full environment scan | Verify both offline OCI proofs and write `provenance-dry-run.json` in the existing qualification collector. | Same source, repository, version, run/attempt, index/platform/statement digests; missing/changed proof blocks. Retain the pair artifact. |
| Two Trivy installations and separate DB caches in an image job | Reuse one checksum-verified Trivy binary and one fresh DB cache within that job. | No concurrent writers to the same cache; validate DB metadata and every report. Never reuse a PASS verdict. |
| Raw upstream-base diagnostics on every main push | Run on pin changes, periodically, and for release qualification. | Exact final runtime/support OCI and build stages remain mandatory for final candidate. Raw HIGH/CRITICAL remains visible. |
| Per-PR full Security Qualification and aggregate gate | Fast + Integration on each HEAD; full qualification once for the final candidate before merge. | Required status enforcement on the exact HEAD/base; unavailable in the current private plan, so activation needs owner policy decision and an enforceable or acknowledged manual merge procedure. |
| Release scan of an already qualified digest | Reuse same-run, fresh scan only if digest, platform, scanner/config, vulnerability DB and policy version match; still reconcile published registry digest. | Mismatch or stale DB blocks or requires a new scan. Publisher tool closure and protected branch requirements remain. |

Questions for owner approval: (1) accept periodic rather than per-job hosted
rootfs evidence, while retaining raw reports; (2) approve the reduced PR
environment set and exact tooling inventory; (3) choose enforceable branch
protection or explicitly accept the manual pre-merge race/bypass; (4) approve
which raw base diagnostics move to periodic/pin-change runs. Until answered,
the existing security gate and release contract stay in force.

## Hosted validation after approval

1. Publish final candidate once: one Fast + Integration PR run. Check all
   routed suites, reports, no unexpected skips, and actual duration.
2. Run one full Security Qualification for that unchanged HEAD/base. Check
   exact OCI and evidence closure, source/run/attempt/digest/DB bindings,
   retained HIGH/CRITICAL and final gate. Recheck HEAD/base before merge.
3. Release remains a separate explicit action and requires its own profile.
