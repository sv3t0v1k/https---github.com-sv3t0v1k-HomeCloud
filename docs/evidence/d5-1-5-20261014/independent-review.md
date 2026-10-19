# D5.1.5 — independent security review

Date: 2026-10-14. Reviewed baseline: 3cbd2a1013032da6f48745500e057d1487282e5e.

**APPROVE the evidence report and the explicitly unimplemented policy proposal. Release remains BLOCKED; Production NO_GO.** No outstanding actionable defect found in the final reviewed report. This is not approval of any CVE disposition, gate change, production image selection, publication, or deployment.

## Reviewed evidence and independent checks

Read the final `docs/evidence/d5-1-5-20261014/report.md` and `production-images.json`, exact PostgreSQL extraction method/evidence, raw govulncheck streaming JSON, per-CVE and symbol evidence, ingress raw scan/sidecar/content inventory, actual repository ingress template and map, archive-path review, and build/CI qualification.

Parsed raw govulncheck JSON independently: 65 finding events, comprising 62 module-level and 3 package-level events, 57 unique finding OSVs, and zero function-level events. Critical GO-2026-4337/CVE-2025-68121 is a stdlib module-only event. All 25 baseline CVE entries have empty affected-symbol intersections and no function findings. A successful JSON exit alone was not used as proof. Official govulncheck documentation confirms binary mode uses symbols and omits source call graphs; the report states that limit correctly.

Independently linked the saved PostgreSQL parent index to amd64 child 1a66d744..., and confirmed original Trivy ImageID equals exact extracted-image config 81bd698b.... This makes the new gosu qualification applicable to that same scan configuration. Actual gosu hash 52c8749d... is retained; the conclusion is specific to that hash, target and advisory snapshot. PostgreSQL server/extensions, data and live configuration are not thereby qualified.

The narrow extractor initially had general whiteout/path-handling limits. Those were raised during review. The final case-specific archive-path-review retains 21 PostgreSQL and 19 ingress target/ancestor header events, with no relevant whiteout/opaque event or non-directory ancestor. This addresses the limitation for these exact image paths; no universal OCI-unpacking safety claim is made.

Ingress raw counts independently confirmed: 2C/60H/97M/50L/2UNKNOWN. The two critical package findings are one CVE-2026-31789. Official OpenSSL advisory independently confirms the 32-bit condition; exact image metadata/APK architectures and ELF64 nginx support a scoped not-affected proposal, not an accepted exclusion. Four nginx CVEs have missing configuration preconditions in inspected repository templates; actual live nginx -T was not checked. Review corrected the initial overbroad formulation: CVE-2026-49975 is separately unresolved due to Apache-description/Alpine-nginx mapping inconsistency. The final report preserves that uncertainty and the 55 other unqualified high findings.

Backend/frontend config ImageIDs, offline OCI platform/index digests and source revision are explicitly distinguished. Offline candidate archives are unavailable, builds differ, and no scan-to-offline-manifest binding is asserted. None is claimed to be an owner-approved or deployed production digest.

Build/CI evidence correctly identifies 161 installed packages versus 88 in the raw base, 73 additions and the known Perl correction. Neither the baseline subtraction nor the package inventory is labelled a new actual execution-environment scan. Executed npm/build stages and separate frontend hosted-runner environment remain uncovered rather than being inferred safe from runtime 0H/0C.

## Policy review

The final policy is clearly labelled proposal only. Current raw-base and HIGH/CRITICAL gates remain active. Proposed production checks cover four exact artifacts with no unresolved H/C; build/CI qualification remains separately required. Raw-base independent blocking can cease only after downstream coverage and explicit owner policy approval. Individual CVE/package/image/architecture decisions require evidence, explicit approval and proposed expiry/invalidation. No group acceptance, silent suppression, changed code, or automatic risk acceptance is present.

## Remaining blockers

- No designated, scan-bound exact production artifact set and approved source revision.
- Ingress has unresolved H/C, including CVE-2026-49975 plus unqualified library findings; corrected image/TLS smoke is absent.
- All gosu and ingress not-affected candidates still require individual owner decisions; raw Trivy results are unchanged.
- Actual executed build/deps/post-apt CI variants and global tooling lack complete scan qualification.
- Current four raw-base failures remain independent active blockers; proposed policy change is not approved or implemented.

No new application tests or CI run are warranted for this documentation/evidence-only snapshot. No scans, image binaries, Docker/mini-PC or repository mutations were performed by this reviewer; the only written item is this requested temporary review report.

Primary sources independently checked:
- https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
- https://openssl-library.org/news/secadv/20260407.txt
