# D5.1.5 — independent review of owner-approved policy implementation

Review date: 2026-10-15 (Asia/Vladivostok). Baseline HEAD: `81d8d68`; reviewed implementation is the current uncommitted narrow source diff.

**Code review: APPROVE. Execution qualification: PENDING CI. Production: NO_GO.** No outstanding concrete security bypass found in the final reviewed source. The owner approved the policy architecture; this review accepts no individual CVE exception, production release, registry publication, or deployment.

## Reviewed scope

Reviewed scan-policy/image/evidence helpers, actual-environment capture and validation, OS/global npm/component inventory coverage, exact OCI scan and loaded-image binding, stage cache proof/export, aggregate policy coverage, production candidate lock and Compose pins, CI workflow, release workflow, and release/provenance qualification/source-contract changes. No old-CVE research, repeated image scans, Docker/mini-PC access, forbidden audit-file access, repository edits or Git mutations were performed by this reviewer. This temporary report is the only file written by the reviewer.

## Security conclusions

- Raw upstream scans become explicitly diagnostic only under the approved architecture. Their complete findings remain visible, and wrong target, malformed/missing package inventory, bad scanner identity and missing/stale DB metadata still fail. Runtime, executed build stages, BuildKit worker, actual job filesystems and installed components retain strict HIGH/CRITICAL blocking. No ignore-unfixed, blanket allowance, individual suppression or continue-on-error exception was introduced.
- PostgreSQL and ingress Compose references match exact old verified amd64 child digests in the candidate lock. These are identity pins, not fixes or claims of safety. No PostgreSQL major/data migration or live deployment operation is introduced. The BuildKit worker directly uses the exact child qualified by its mandatory support-image scan.
- Backend/frontend are built once to retained OCI archives. Source/provenance verification, archive-to-scan config/rootfs binding, loaded-image config/rootfs identity and smoke checks refer to that same candidate. PR source selection explicitly uses the branch head rather than silently treating the synthetic merge revision as approved source.
- Build-stage exports qualify only when all observed security-relevant RUN/COPY/ADD operations are completed cache hits, with role-specific minimum RUN coverage and a completed export. A cache miss/rebuilt operation, missing/truncated progress or missing build metadata blocks coverage. Progress/metadata hashes and stage config/runtime digest bindings are retained. This intentionally fails closed rather than claiming that a later rebuilt stage was the stage that produced the candidate.
- Actual environment scans exclude the checkout before rootfs traversal and scan only the selected application directory separately. Pseudo/temp/output/cache/Docker storage paths are excluded; installed OS/toolcache/global npm directories remain covered. Pinned Trivy walker source was checked during review: directory exclusions return SkipDir before file opening, and filesystem symlinks are not traversed. No developer-host rootfs scan is allowed by the helper.
- Actual dpkg installed-package names/full Debian versions/architectures must be present in scanner OS inventory; removed/config-only dpkg records are excluded from that comparison. Actual global npm and selected component graphs/manifests must be covered by matching package name/version and installed manifest paths. Failed npm inventories, missing actual dependencies, missing required language scans and missing build-stage npm inventory cannot silently pass.
- The aggregate requires all four runtime roles, four executed stages, BuildKit, every enumerated actual CI environment and all four pinned raw diagnostics. Expected application component scopes cannot be omitted. Changed reports, source/config/lock mismatch, invalid evidence, missing/duplicate artifacts or incomplete cache/environment coverage block the result. Any unresolved HIGH/CRITICAL in mandatory scopes blocks it even when coverage is otherwise complete.
- Release preparation consumes the same-run qualified retained archives and recomputes archive/provenance identity before registry access; it does not rebuild a different unscanned application image. Qualification checks source/run/attempt, exact required role sets and strict results. Published-digest scans remain required before draft creation. These are future workflow safeguards; no publication or release execution was performed here.

## Review findings corrected before approval

1. An actual-environment false-PASS was safely reproduced with a failed global npm inventory and no global-tool scan coverage. Required successful graph/manifests and installed-path coverage now close it.
2. The aggregate could previously omit an application's component scan. Required environment-to-component mapping and exact report sets now close it.
3. Nonempty OS inventory alone did not establish coverage of added packages. Full installed dpkg coverage now closes that gap.
4. Raw diagnostic roles were not checked against configured pinned inputs. Exact role/reference checks now apply.
5. Separate stage exports lacked proof of runtime-build cache reuse. Cache-only operation proof and bound progress/build metadata now enforce the stated boundary; truncated JSON no longer qualifies.
6. The loaded smoke image was checked only for architecture. Exact config and rootfs equality are now required.
7. Backend/stage image reports could omit Node language inventory. Role-specific Node/global npm presence checks now reject that omission.

## Validation and remaining limits

Root reports 78 targeted checks passing: release19, provenance9, scan-evidence10, scan-policy7, environment16, OCI binding6, aggregate coverage8 and cache proof3. CI/release actionlint and shell syntax checks pass. The reviewer did not repeat those completed suites.

Actual GitHub execution of this new source is still pending. In particular, real Trivy package-path/inventory representation, archive loading and BuildKit cache-progress evidence must satisfy the strict checks in that run; local fixture success is not substituted for that evidence. No fresh clean-image or full-suite result is claimed. Existing unresolved PostgreSQL/ingress/build/CI CVEs remain blockers, no individual disposition is approved, and COMPLETE/Production GO must remain unset.

Pinned walker source supporting the exclusion boundary:
https://raw.githubusercontent.com/aquasecurity/trivy/v0.75.0/pkg/fanal/walker/fs.go

## Integration-fix review

Targeted integration fixes: APPROVE. Trivy image/rootfs unsupported flag removed; filesystem dev flag retained. Physical package coverage remains strict. Qualified npm empty optional slots and aliases are reconciled against actual installed manifests; malformed/missing/invalid records still block. Skopeo tag normalization preserves repository@exactdigest and locked platform validation. Environment targeted tests now 18 PASS, total 80 PASS. Gitleaks findings remain a separate unresolved blocker; no suppression added.
