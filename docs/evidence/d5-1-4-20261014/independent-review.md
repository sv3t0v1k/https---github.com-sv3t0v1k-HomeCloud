# D5.1.4 — independent security review

Review date: 2026-10-14. Source baseline: `745bfebcd422ab8be39d29d58c977458f5fe44da`.

**Change review: APPROVE. Release qualification: BLOCKED; Production NO_GO.** No actionable security defect found in the reviewed narrow change. Approval covers the evidence/CI hardening and policy documentation only. It approves no CVE exception, release, deployment, or reduction of an existing gate.

## Reviewed scope

Read exact backend/frontend Dockerfiles, `scripts/ci/images.lock.json`, `scripts/ci/images.platforms.json`, `.github/workflows/ci.yml`, `scripts/ci/scan-image.sh`, new `scan-evidence.py`/`test-scan-evidence.py`, narrow `release.py` change, production/base Compose image/profile declarations, `docs/image-security-policy.md`, D5.1.4 qualification/evidence files, and ROADMAP/release-management diffs. No broad repository audit, Docker operation, mini-PC connection, repository edit, Git mutation, or forbidden-file access was performed by this reviewer.

## Findings

- Existing HIGH/CRITICAL predicate, all-severity retained JSON, `--ignore-unfixed=false`, explicit empty ignore file, and aggregate CI dependency on raw-base scans remain intact. No blanket/individual suppression or continue-on-error was introduced.
- Freshness checks reject stale/missing/overdue DB metadata and target/platform/scanner mismatch. Sidecar `evidence_status` represents evidence validity only; it does not convert a vulnerable image to PASS. RFC3339 nanosecond truncation preserves subsecond ordering at Python microsecond precision. Root reports seven adversarial/guard tests passing and real Trivy0.75 candidate execution accepting the new flags/cache path. This reviewer did not repeat those tests.
- CI Perl is pinned to the documented fixed Debian revision and verified after installation. This is an execution-environment correction; original immutable raw-base findings remain unchanged. Package inventory is correctly described as inventory rather than a post-install vulnerability scan. Final actual CI installation/version evidence is pending.
- Backend's npm removal and frontend's three library upgrades explain runtime/base count differences. They do not prove builder/CI safety.
- PostgreSQL critical CVE-2025-68121 plus 24 high findings are Go stdlib v1.24.6 in gosu1.19. Inspected source indicates no TLS/network parsing path, but this is not exact-image binary call-graph proof and is correctly not treated as an approved exception. Source-built PostgreSQL server coverage is explicitly distinguished from zero OS findings.
- Checked all six retained D5.1.3 scan hashes, counts, and ArtifactName values against the exact saved raw reports: all match findings.json. Baseline runtime 0C/0H/2M each and raw bases Node8H, nginx3H, PostgreSQL1C/24H, CI Node4C/60H are represented accurately. Prior backend1148/frontend278 test totals are reused historical evidence, not fresh tests.
- Candidate PostgreSQL16 Bookworm4C/87H and Node24 Trixie0C/51H are transparently rejected. No PostgreSQL major, data format, actual PGDATA, or deployed image was changed. Candidate sidecars explicitly bind metadata and exact requested references; old CI DB freshness is honestly unresolved rather than inferred from unrelated metadata.
- Production Compose inherits floating PostgreSQL16-alpine and uses separate floating nginx1.28-alpine ingress. Neither is bound to the exact production image coverage claimed by existing frontend/base scans. Redis is opt-in and remains unqualified for activation. Documentation correctly records these gaps.

## Remaining release blockers

1. Existing four raw-base HIGH/CRITICAL gates remain failing; individual dispositions are not approved.
2. Production PostgreSQL/ingress exact digests and complete scan qualification remain unresolved.
3. Actual post-apt CI image and executed build/deps stages lack final-image scan qualification; inventory alone does not close this.
4. Exact-image PostgreSQL/gosu applicability or a tested patched replacement remains unproven; no safe clean alternative was adopted.
5. Final GitHub CI for the new source is pending at review time; prior runtime/test evidence must not be relabelled as current-source CI success.

ROADMAP keeps D5.1.4_RELEASE_BLOCKED and D5.2 NOT_STARTED; COMPLETE/Production GO are not set.
