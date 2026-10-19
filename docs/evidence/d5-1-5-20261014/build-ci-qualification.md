# D5.1.5 — actual build/deps/CI qualification (read only)

Evidence reused: `outputs/d5-1-4-20261014/artifacts/ci-toolchain-packages-1/ci-toolchain-packages.txt`, `image-scan-base-node-ci-1/image-base-node-ci.json`, `image-scan-base-node-1/image-base-node.json`, backend/frontend runtime scan JSON + sidecars. Exact backend/frontend Dockerfiles, `images.lock.json`, and relevant existing workflow commands inspected. No repo/Git edits, scans, installations, Docker daemon operations, or forbidden audit-file access.

## Proven environment boundaries

| Environment | Actual execution and copied outputs | Security evidence retained |
|---|---|---|
| Backend Docker deps | pinned Node24.21 Alpine; adds libc6-compat; npm ci --omit=dev, npm cache clean; node_modules copied into runner | Raw Node base scan + final runtime scan; no deps-stage scan/inventory |
| Backend Docker builder | same pinned Node base; adds gcc/musl-dev/linux-headers; npm ci; native compilation + application build | Raw Node base scan + final runtime scan; no builder-stage scan/inventory |
| Backend production runner | same base; removes global npm/npx, copies production node_modules/dist/native addon | Actual final image 0H/0C, 2M (D514 run, immutable source2a01cc812bed10a7ba96769d3dce2524b1e8edec) |
| Frontend Docker deps/builder | pinned Node Alpine; deps adds libc6-compat; npm ci; builder receives node_modules and builds assets | Raw Node base scan; no intermediate stage scan/inventory |
| Frontend production runner | pinned nginx1.30.5; patches libexpat/pcre2/tiff; receives only built dist assets | Actual final image 0H/0C, 2M (same source) |
| Backend test CI | pinned Node24.21 Bookworm-slim; apt installs gcc/libc6-dev/git/python3/util-linux/ca-certificates and exact patched perl-base; npm ci --no-audit; native build; tests as node user | Raw immutable base scan plus real postinstall dpkg inventory; no postinstall execution-environment scan |
| Frontend test CI | ubuntu24.04 hosted runner + setup-node24.21, project npm ci | Distinct environment; CI Node Bookworm raw scan does not cover it |

Base-image scan is genuinely the configured raw immutable base, linux/amd64. Its D514 sidecar records DB UpdatedAt2026-10-14T07:11:52Z, download12:51Z, scan12:51Z; evidence PASS. That fact does not make it a scan of the modified CI environment.

## Actual CI package delta, with complete Debian versions

Inventory has161 package names. Raw CI-base report contains88 OS packages; all88 remain installed. Reconstructing full version from Epoch + Version + Release (not Version alone), only perl-base changed:5.36.0-7+deb12u3 →5.36.0-7+deb12u4. There are73 additional packages. Do not mistake Trivy's normalized upstream Version field for a Debian package upgrade.

Actual perl, perl-base, perl-modules-5.36 and libperl5.36 are all5.36.0-7+deb12u4. Matching the raw findings' FixedVersion establishes correction of these baseline findings in the real postinstall environment:

- Critical: CVE-2026-13221, CVE-2026-42496, CVE-2026-8376.
- High: CVE-2026-42497, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433.
- Medium: CVE-2025-15649, CVE-2026-12087, CVE-2026-19487, CVE-2026-48959, CVE-2026-7010, CVE-2026-7017.

The raw base still correctly reports4C/60H for itself. Those are not actual CI postinstall totals. Subtracting known corrected Perl findings would leave a baseline comparison set1C/56H; this is NOT a new scan result and omits findings potentially added by the73 packages.

| Remaining inherited source group | Actual installed packages/version | Relevant baseline H/C IDs and limitation |
|---|---|---|
| util-linux | bsdutils1:2.38.1-5+deb12u3; libblkid1/libmount1/libsmartcols1/libuuid1/mount/util-linux/util-linux-extra2.38.1-5+deb12u3 | CVE-2026-53613,76642,78408,78409,78410; repeated40H package findings, unchanged versions; exact invocation/privilege reachability unresolved |
| gzip |1.12-1 | CVE-2026-41992; crafted LZW then LZH same-process decompression trigger; no Bookworm fix recorded |
| acl |libacl1 2.3.1-3 | CVE-2026-54369; privileged pathname ACL operations with attacker-controlled path components; ABI change prevents simple individual backport per Debian |
| systemd |libsystemd0/libudev1 252.39-1~deb12u2 | CVE-2026-16742; homed-specific, source mapping; homed package absent from inventory, executable absence still needs direct proof |
| ncurses |libtinfo6/ncurses-base/ncurses-bin6.4-4 | CVE-2025-69720; actual vulnerable function is infocmp CLI, present in raw ncurses-bin InstalledFiles; added libncursesw6 has same source version but no actual scan |
| Perl |four packages at5.36.0-7+deb12u4 | CVE-2026-9538 remains vulnerable per current Debian tracker; Archive::Tar before3.10 unbounded entry-size allocation. Newly added perl-modules includes Archive/Tar.pm (official package file list); real call/input exposure not proved |
| zlib |zlib1g1:1.2.13.dfsg-1 | CVE-2023-45853 candidate source-only mismatch: upstream contrib/minizip not built in Bookworm zlib; raw zlib1g InstalledFiles has no minizip and inventory adds no minizip package. Separate vendored code is outside dpkg proof |

## Build npm tooling

Raw Alpine and Bookworm bases contain npm11.19.0. All8 base Node H paths are inside global npm dependencies: brace-expansion5.0.7 (CVE-2026-102276/102278/14257/69152), http-cache-semantics4.2.0 (CVE-2026-93748, upstream disputed), ip-address10.2.0 (CVE-2026-69192), tar7.5.19 (CVE-2026-73566), undici6.27.0 (CVE-2026-19534).

Docker build stages and backend CI invoke this tooling; removal is only in backend production runner. No workflow command upgrades/replaces global npm. Expected continued presence is a source-command inference, not file attestation: dpkg inventory does not cover /usr/local npm installation. Project npm ci changes project node_modules; it does not update bundled global npm. Latest npm12.2 still bundled vulnerable versions in prior checked official lockfile; no safe all-clear upgrade established.

## Added toolchain coverage gaps

Representative73 added packages: gcc/gcc-12/cpp/binutils2.40-2 and associated libraries; libc6-dev/libc-dev-bin2.36-9+deb12u14; git/git-man1:2.39.5-0+deb12u3; libcurl3-gnutls7.88.1-10+deb12u15; libexpat1 2.5.0-1+deb12u4; libssl3/openssl3.0.22-1~deb12u1; python3.11 3.11.2-6+deb12u9; libsqlite3-0 3.40.1-2+deb12u2; Perl modules/libperl at patched u4; libncursesw6 6.4-4; linux-libc-dev6.1.187-1. These exact versions are known, but no vulnerability scan of their combined execution environment is retained. A version string alone neither proves vulnerable nor proves safe, especially with distro security backports.

Dynamic APK installs in build/deps stages are not package-version pinned in Dockerfiles. Build date, base digest and final runtime image do not establish exact gcc/musl-dev/linux-headers/libc6-compat versions that executed. Final runtime does not copy build-stage OS toolchain, but compiler and npm processes can affect artifacts copied forward. Thus0H runtime cannot substitute for build-environment qualification.

## Minimal bounded qualification method (no policy decision)

1. With only retained evidence: preserve immutable-base scan as baseline; join full Debian package versions as done above; report the known Perl correction and remaining unchanged source groups. Qualify exact added source packages using vendor status and signed repository package metadata if needed, with an explicit inventory-only label. Do not manufacture a rootfs or label a synthetic SBOM result an actual-environment scan.
2. Next authorized existing GitHub CI execution: retain OS source+binary inventory and global npm package manifests directly from the backend container after apt, before repository installation, and after dependency installation. One direct scan of this actual container filesystem/SBOM, using the existing pinned scanner and fresh-DB sidecar, covers postinstall packages without Mac Docker. No separate workflow is inherently needed; minimal instrumentation of the existing job is sufficient. In-container filesystem scans require an honest source-kind/platform evidence path, not pretending to satisfy current container-image JSON assertion.
3. For Docker deps/build stages: from the existing ephemeral GitHub build execution, export/scan each unique stage once (backend deps,builder; frontend deps,builder), retaining target name, source commit, base digest, actual APK inventory and language package paths. Reuse stage artifacts/cache if available; none are in the inspected retained artifact set. Do not rebuild solely to infer old stage contents; reproduction today is new evidence, not historical identity.
4. If no executable environment or existing intermediate export is available, exact old build-stage security state remains unverified. Stop at that evidence boundary; no mass scans or unsupported0H claims.

Primary sources reused from D514: official Node/npm/Undici advisories and Debian tracker for fixed Perl versions, zlib, util-linux and systemd. Fresh narrow checks: https://security-tracker.debian.org/tracker/CVE-2026-9538 ; https://security-tracker.debian.org/tracker/CVE-2026-54369 ; https://security-tracker.debian.org/tracker/CVE-2025-69720 ; https://packages.debian.org/bookworm/all/perl-modules-5.36/filelist . No policy changes or exceptions proposed/applied here.
