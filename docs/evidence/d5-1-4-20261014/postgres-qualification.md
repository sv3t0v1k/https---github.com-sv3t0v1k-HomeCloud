# D5.1.4 PostgreSQL read-only qualification

Evidence: /private/tmp/homecloud-d513-final-scans/image-scan-base-postgres-1/image-base-postgres.json

Exact scan target: `docker.io/library/postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`. Report CreatedAt 2026-10-14T12:29:05.010488113Z, Trivy 0.75.0. Metadata linux/amd64, Alpine 3.24.2, PG_VERSION=16.15, GOSU_VERSION=1.19. Lock digest matches. All 1 critical + 24 high are `stdlib@v1.24.6` in `usr/local/bin/gosu`; OS target has zero high/critical. There are no scanner findings against PostgreSQL server itself in this artifact. This does not prove scanner coverage of source-built PostgreSQL.

## Trust and freshness

The JSON contains no vulnerability DB schema/update/download/next-update metadata or digest. CreatedAt proves only reported scan time. No DB freshness guarantee can be derived from this artifact alone. Existing logs/DB metadata must supply that evidence. All 25 CVE aliases and exact stdlib fixed ranges were independently retrieved and matched to official Go OSV JSON on 2026-10-14 (files /private/tmp/homecloud-d514-go-advisories). None is withdrawn. Therefore the advisory identifiers and versions are genuine; package version matching alone is insufficient to establish exploitability.

## Critical and reachability

CVE-2025-68121 affects crypto/tls session resumption when ClientCAs/RootCAs change between initial/resumed handshake. Official fixed ranges: 1.24.13, 1.25.7, 1.26.0-rc.3. gosu tag 1.19 main.go imports os,os/exec,runtime,syscall; SetupUser uses moby/sys/user v0.1.0 and x/sys/unix to parse local passwd/group, setgroups/setgid/setuid then syscall.Exec. No TLS client/server or certificate validation call path is present in the inspected tagged source. gosu exits by exec and is not a resident PostgreSQL network server. This supports source-inferred non-reachability for the critical; it is NOT an approved exception and not exact-image binary-level call graph proof.

The same source inference applies separately to every affected package/symbol below: local passwd/group parsing does not use HTTP/URL/mail/MIME/XML/ASN.1/template parsing, DNS or TLS. The os.Root CVE affects Root/OpenInRoot APIs, whereas gosu and inspected user dependency use os.Open rather than those APIs. Windows-specific net CVE does not apply to linux/amd64. CGO resolver CVE also conflicts with upstream gosu build CGO_ENABLED=0 and no LookupCNAME path.

Upstream tagged SECURITY.md explicitly warns that gosu does not invoke net/http, archive/tar, encoding/xml and recommends govulncheck rather than version-only conclusions. Tagged wrapper excludes only GO-2023-1840/CVE-2023-29403, not any of these 25. No wrapper/scanner was executed here, and no suppression or allowlist is recommended as an automatic action.

| CVE | Severity | Installed | Fixed stdlib versions | Official affected package / source-inferred applicability |
|---|---|---|---|---|
| [CVE-2025-68121](https://vuln.go.dev/ID/GO-2026-4337.json) | CRITICAL | v1.24.6 | 1.24.13, 1.25.7, 1.26.0-rc.3 | crypto/tls; No call path in inspected gosu source |
| [CVE-2025-61726](https://vuln.go.dev/ID/GO-2026-4341.json) | HIGH | v1.24.6 | 1.24.12, 1.25.6 | net/url; No call path in inspected gosu source |
| [CVE-2025-61729](https://vuln.go.dev/ID/GO-2025-4155.json) | HIGH | v1.24.6 | 1.24.11, 1.25.5 | crypto/x509; No call path in inspected gosu source |
| [CVE-2026-25679](https://vuln.go.dev/ID/GO-2026-4601.json) | HIGH | v1.24.6 | 1.25.8, 1.26.1 | net/url; No call path in inspected gosu source |
| [CVE-2026-27145](https://vuln.go.dev/ID/GO-2026-5037.json) | HIGH | v1.24.6 | 1.25.11, 1.26.4 | crypto/x509; No call path in inspected gosu source |
| [CVE-2026-32280](https://vuln.go.dev/ID/GO-2026-4947.json) | HIGH | v1.24.6 | 1.25.9, 1.26.2 | crypto/x509; No call path in inspected gosu source |
| [CVE-2026-32281](https://vuln.go.dev/ID/GO-2026-4946.json) | HIGH | v1.24.6 | 1.25.9, 1.26.2 | crypto/x509; No call path in inspected gosu source |
| [CVE-2026-32283](https://vuln.go.dev/ID/GO-2026-4870.json) | HIGH | v1.24.6 | 1.25.9, 1.26.2 | crypto/tls; No call path in inspected gosu source |
| [CVE-2026-33811](https://vuln.go.dev/ID/GO-2026-4981.json) | HIGH | v1.24.6 | 1.25.10, 1.26.3 | net; No LookupCNAME; upstream CGO_ENABLED=0 |
| [CVE-2026-33814](https://vuln.go.dev/ID/GO-2026-4918.json) | HIGH | v1.24.6 | 1.25.10, 1.26.3 | net/http; No call path in inspected gosu source |
| [CVE-2026-33818](https://vuln.go.dev/ID/GO-2026-5972.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | encoding/asn1; No call path in inspected gosu source |
| [CVE-2026-39820](https://vuln.go.dev/ID/GO-2026-4986.json) | HIGH | v1.24.6 | 1.25.10, 1.26.3 | net/mail; No call path in inspected gosu source |
| [CVE-2026-39821](https://vuln.go.dev/ID/GO-2026-5026.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | net/http, net/http/internal/http2; No call path in inspected gosu source |
| [CVE-2026-39822](https://vuln.go.dev/ID/GO-2026-4970.json) | HIGH | v1.24.6 | 1.25.12, 1.26.5, 1.27.0-rc.2 | os; Root/OpenInRoot APIs unused; os.Open alone is not affected API |
| [CVE-2026-39836](https://vuln.go.dev/ID/GO-2026-4971.json) | HIGH | v1.24.6 | 1.25.10, 1.26.3 | net; Windows-only; image is Linux amd64 |
| [CVE-2026-42499](https://vuln.go.dev/ID/GO-2026-4977.json) | HIGH | v1.24.6 | 1.25.10, 1.26.3 | net/mail; No call path in inspected gosu source |
| [CVE-2026-42504](https://vuln.go.dev/ID/GO-2026-5038.json) | HIGH | v1.24.6 | 1.25.11, 1.26.4 | mime; No call path in inspected gosu source |
| [CVE-2026-56853](https://vuln.go.dev/ID/GO-2026-6089.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | net/http; No call path in inspected gosu source |
| [CVE-2026-56858](https://vuln.go.dev/ID/GO-2026-6091.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | html/template; No call path in inspected gosu source |
| [CVE-2026-56859](https://vuln.go.dev/ID/GO-2026-6088.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | encoding/xml; No call path in inspected gosu source |
| [CVE-2026-56860](https://vuln.go.dev/ID/GO-2026-6218.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | net/url; No call path in inspected gosu source |
| [CVE-2026-56862](https://vuln.go.dev/ID/GO-2026-6090.json) | HIGH | v1.24.6 | 1.25.13, 1.26.6, 1.27.0-rc.3 | crypto/tls; No call path in inspected gosu source |
| [CVE-2026-78667](https://vuln.go.dev/ID/GO-2026-6609.json) | HIGH | v1.24.6 | 1.26.9, 1.27.2 | net/http; No call path in inspected gosu source |
| [CVE-2026-78669](https://vuln.go.dev/ID/GO-2026-6611.json) | HIGH | v1.24.6 | 1.26.9, 1.27.2 | net/http, net/http/internal/http2; No call path in inspected gosu source |
| [CVE-2026-97031](https://vuln.go.dev/ID/GO-2026-6607.json) | HIGH | v1.24.6 | 1.26.9, 1.27.2 | crypto/tls; No call path in inspected gosu source |

## PostgreSQL support and alternatives

[Official PostgreSQL versioning](https://www.postgresql.org/support/versioning/) currently lists 16.15 as current supported PG16 minor, support through 2028-11-09. [Official security table](https://www.postgresql.org/support/security/) latest PG16 fixes are included in 16.15. PostgreSQL source-built version from metadata agrees, but server binary has not been executed or independently hashed.

No verified safe alternative registry digest is established by this subtask. Root agent is checking registry metadata. Same PG16 patch/digest refresh can preserve PostgreSQL data directory format; switching Alpine to Debian introduces libc/locale/collation/ICU differences and extension ABI/UID/permissions risks and needs disposable restore + migration qualification. A same-major tag alone is not compatibility proof. No actual data, Docker daemon, or deployment was touched.

Concrete remediation option without PG major/data changes: derive image from the identical pinned PG16 digest, replace gosu1.19 with the exact reviewed/tagged source compiled using pinned current patched Go >=1.26.9 or >=1.27.2. Preserve /usr/local/bin/gosu and su-exec link, execute uid/gid/group and startup tests in disposable CI, scan resulting exact amd64 image, validate restore+migrations against disposable PG16 data. This is a candidate, not an implemented/verified remediation; raw upstream-base scan would still report original findings under existing policy, so gate target changes require explicit approval.

Alternative: exact-image binary-level govulncheck with no exclusions and preserved image/provenance + DB freshness may justify per-CVE not-affected proposals, but each approval must remain individual and current gate stays unchanged. The strongest current evidence is source-inferred nonreachability, not proof that scanner findings should be discarded.

## Primary source references

- https://pkg.go.dev/vuln/GO-2026-4337
- https://raw.githubusercontent.com/tianon/gosu/1.19/main.go
- https://raw.githubusercontent.com/tianon/gosu/1.19/setup-user.go
- https://raw.githubusercontent.com/tianon/gosu/1.19/go.mod
- https://raw.githubusercontent.com/tianon/gosu/1.19/SECURITY.md
- https://raw.githubusercontent.com/tianon/gosu/1.19/govulncheck-with-excludes.sh
- https://raw.githubusercontent.com/tianon/gosu/1.19/Dockerfile
- https://raw.githubusercontent.com/moby/sys/user/v0.1.0/user/user.go
- https://raw.githubusercontent.com/moby/sys/user/v0.1.0/user/lookup_unix.go
- https://www.postgresql.org/support/versioning/
- https://www.postgresql.org/support/security/
- https://www.postgresql.org/docs/16/upgrading.html
- https://www.postgresql.org/docs/release/16.15/
