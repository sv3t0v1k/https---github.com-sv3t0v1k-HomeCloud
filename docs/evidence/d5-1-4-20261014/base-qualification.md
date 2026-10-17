# D5.1.4 Node/nginx/CI qualification (read only)

Evidence: D5.1.3 final scans `/private/tmp/homecloud-d513-final-scans`, not stale outputs D5.1.2. Reports are Trivy 0.75.0 dated 2026-10-14T12:29Z, linux/amd64. They retain artifact identity but no DB timestamps or DB digest. A fresh report timestamp does not prove fresh DB. No image scans or daemon calls executed in this qualification.

## Exact retained findings

| Image | CVE | Severity | Packages | Installed | Fixed (retained scanner claim) | Status |
|---|---|---|---|---|---|---|
| node | CVE-2026-102276 | HIGH | brace-expansion | 5.0.7 | 5.0.10, 3.0.7, 2.1.5, 1.1.19 | fixed |
| node | CVE-2026-102278 | HIGH | brace-expansion | 5.0.7 | 5.0.11, 3.0.8, 2.1.6, 1.1.20 | fixed |
| node | CVE-2026-14257 | HIGH | brace-expansion | 5.0.7 | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | fixed |
| node | CVE-2026-69152 | HIGH | brace-expansion | 5.0.7 | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | fixed |
| node | CVE-2026-93748 | HIGH | http-cache-semantics | 4.2.0 | none | affected |
| node | CVE-2026-69192 | HIGH | ip-address | 10.2.0 | 10.3.1 | fixed |
| node | CVE-2026-73566 | HIGH | tar | 7.5.19 | 7.5.21 | fixed |
| node | CVE-2026-19534 | HIGH | undici | 6.27.0 | 6.28.1, 7.29.1, 8.10.2 | fixed |
| nginx | CVE-2026-93990 | HIGH | libexpat | 2.8.4-r0 | 2.8.5-r0 | fixed |
| nginx | CVE-2026-103111 | HIGH | pcre2 | 10.48-r0 | 10.49-r0 | fixed |
| nginx | CVE-2026-4775 | HIGH | tiff | 4.7.1-r0 | 4.7.2-r0 | fixed |
| node-ci | CVE-2026-53613 | HIGH | bsdutils | 1:2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-76642 | HIGH | bsdutils | 1:2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78408 | HIGH | bsdutils | 1:2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78409 | HIGH | bsdutils | 1:2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78410 | HIGH | bsdutils | 1:2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-41992 | HIGH | gzip | 1.12-1 | none | fix_deferred |
| node-ci | CVE-2026-54369 | HIGH | libacl1 | 2.3.1-3 | none | fix_deferred |
| node-ci | CVE-2026-53613 | HIGH | libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-76642 | HIGH | libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78408 | HIGH | libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78409 | HIGH | libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-78410 | HIGH | libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 | none | affected |
| node-ci | CVE-2026-16742 | HIGH | libsystemd0, libudev1 | 252.39-1~deb12u2 | none | fix_deferred |
| node-ci | CVE-2025-69720 | HIGH | libtinfo6, ncurses-base, ncurses-bin | 6.4-4 | none | affected |
| node-ci | CVE-2026-13221 | CRITICAL | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-42496 | CRITICAL | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-8376 | CRITICAL | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-42497 | HIGH | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-48962 | HIGH | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-57432 | HIGH | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-57433 | HIGH | perl-base | 5.36.0-7+deb12u3 | 5.36.0-7+deb12u4 | fixed |
| node-ci | CVE-2026-9538 | HIGH | perl-base | 5.36.0-7+deb12u3 | none | fix_deferred |
| node-ci | CVE-2023-45853 | CRITICAL | zlib1g | 1:1.2.13.dfsg-1 | none | will_not_fix |
| node-ci | CVE-2026-102276 | HIGH | brace-expansion | 5.0.7 | 5.0.10, 3.0.7, 2.1.5, 1.1.19 | fixed |
| node-ci | CVE-2026-102278 | HIGH | brace-expansion | 5.0.7 | 5.0.11, 3.0.8, 2.1.6, 1.1.20 | fixed |
| node-ci | CVE-2026-14257 | HIGH | brace-expansion | 5.0.7 | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | fixed |
| node-ci | CVE-2026-69152 | HIGH | brace-expansion | 5.0.7 | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | fixed |
| node-ci | CVE-2026-93748 | HIGH | http-cache-semantics | 4.2.0 | none | affected |
| node-ci | CVE-2026-69192 | HIGH | ip-address | 10.2.0 | 10.3.1 | fixed |
| node-ci | CVE-2026-73566 | HIGH | tar | 7.5.19 | 7.5.21 | fixed |
| node-ci | CVE-2026-19534 | HIGH | undici | 6.27.0 | 6.28.1, 7.29.1, 8.10.2 | fixed |

## Qualification and targeted options

- Node base: every high finding has `PkgPath=usr/local/lib/node_modules/npm/node_modules/.../package.json`. Backend runner explicitly deletes npm/npx, explaining runtime 0H without contradicting base 8H. These paths remain in build/deps stages and CI. Removing npm from stages that run npm ci is not viable.
- nginx base: all three highs are libraries, not nginx server CVEs. Frontend runner already upgrades exact libexpat2.8.5-r0/pcre2 10.49-r0/tiff4.7.2-r0, explaining runtime delta. Current nginx 1.30.5 is official stable; no newer 1.30 stable release is currently listed. Base digest refresh or separately qualified derived base is a possible targeted remediation, but old immutable upstream digest cannot be changed by a runner layer.
- Node24 latest official directory lists 24.21.0. Blindly searching for a newer Node24 release is unwarranted. Rebuilt same-version distro image may still differ; inspect exact digest first.
- npm12.2.0 is compatible with Node24.21 (engines ^22.22.2 || ^24.15.0 || >=26), npm11.20.0 also accepts it. However npm12.2.0 upstream lockfile still bundles brace-expansion5.0.9, undici6.28.0, http-cache-semantics4.2.0. Therefore npm upgrade alone does NOT clear current findings: brace requires5.0.11 and undici6.28.1. Targeted globally vendored dependency replacement would create a maintained custom npm distribution and needs explicit package-integrity/behavior checks; do not claim upstream-supported clean npm.
- CVE-2026-93748 is disputed by upstream maintainer, closed not planned Oct4; no supported fixed version is established. Do not copy apparent 4.3.x overrides from unrelated issue cross-references. Formal individual disposition requires approval under current strict gate.
- CI Node bookworm: perl-base5.36.0-7+deb12u4 is an official security fix for seven findings (3C+4H). A derived CI image with this targeted upgrade is feasible; changing just a workflow apt step does not fix the scanned original immutable base. Full actual CI image includes additional installed gcc/libc6-dev/git/python3/util-linux, so raw-base scan is useful but incomplete for execution risk.
- CVE-2023-45853 on zlib1g is a strong false-positive candidate: Debian says vulnerable contrib/minizip is not built for bookworm and no binary package built by vulnerable source is affected. Verify image binary/file inventory before individual disposition; do not silently suppress.
- CVE-2026-8376 is documented 32-bit Perl overflow; target report is amd64. Need actual perl configuration/binary proof to close architecture applicability. Upgrade perl remains better than exemption when patch available.
- CVE-2026-16742 affects systemd-homed user management; report flags libsystemd0/libudev1 from source mapping. Need demonstrate homed executable/module absence from image before non-applicable disposition.
- Five util-linux CVEs are repeated across eight binaries/libraries (40 findings). They concern mount/nsenter capabilities and helpers, not every linked library entry necessarily reachable. Rootless/no CAP_SYS_ADMIN/no untrusted mount input reduces exposure but binary/privilege evidence is needed. Bookworm has no recorded fixed version; trixie2.41.5 security is fixed for CVE-2026-53613. Distro migration is broader and cannot be declared clean from this one advisory.
- gzip LZW then LZH same-process decompression is the specific CVE-2026-41992 trigger. Bookworm fix postponed; trixie1.13-1+deb13u1 fixed. Presence alone does not prove CI receives this input.
- 4C/60H are package findings; CI report has 26 unique H/C CVE IDs. Distinguish repeated source-package CVEs from unique vulnerability count.

## Primary sources checked

- https://nodejs.org/en/blog/release/v24.21.0 (release, bundled Node Undici7.29.1; npm bundled Undici6.27.0 finding is distinct)
- https://nodejs.org/download/release/latest-v24.x/ (latest Node24)
- https://nginx.org/en/download.html (1.30.5 stable)
- https://github.com/npm/cli/releases (npm12.2.0 and11.20.0)
- https://raw.githubusercontent.com/npm/cli/v12.2.0/package.json (engines)
- https://raw.githubusercontent.com/npm/cli/v12.2.0/package-lock.json (bundled dependency versions)
- https://github.com/kornelski/http-cache-semantics/issues/56 (dispute)
- https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5 (fixed6.28.1/7.29.1/8.10.2)
- https://github.com/PCRE2Project/pcre2/security/advisories/GHSA-r9hj-j2rw-4q3m (fixed10.49; attacker-controlled JIT regex + growable JIT stack trigger)
- https://github.com/libexpat/libexpat/releases/tag/R_2_8_5 (official release references CVE fix)
- https://security-tracker.debian.org/tracker/CVE-2023-45853
- https://security-tracker.debian.org/tracker/CVE-2026-8376
- https://security-tracker.debian.org/tracker/CVE-2026-13221
- https://security-tracker.debian.org/tracker/CVE-2026-42496
- https://security-tracker.debian.org/tracker/CVE-2026-53613
- https://security-tracker.debian.org/tracker/CVE-2026-16742
- https://security-tracker.debian.org/tracker/CVE-2026-41992

Alpine package browser URLs unavailable via web tool; no external confirmation of Alpine package revisions claimed beyond retained scan and current Dockerfile. No repo modifications, Git mutations, tests, rescans or forbidden-file access performed.
