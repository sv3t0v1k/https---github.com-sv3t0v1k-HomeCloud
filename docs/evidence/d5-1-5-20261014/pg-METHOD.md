# D5.1.5 Exact PostgreSQL/gosu binary qualification

## Bound identity

- Registry reference: docker.io/library/postgres@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551
- Parent index supplied by root: sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea; child binding is qualified separately by root.
- Raw manifest digest independently SHA256-verified against the requested child. Config and every downloaded layer also hash-verified against that manifest.
- Config digest sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542; config architecture amd64, OS linux, PG_VERSION16.15/GOSU_VERSION1.19.
- Only target regular file usr/local/bin/gosu and entrypoint were copied out by tarfile member reads, not filesystem extraction. Layer order and target whiteouts checked. No later layer overrode gosu. Final origin layer sha256:210b280f9556440a6475a3d20cb52baac3ed21a482dbc5889005d9da5ec612f4.
- Exact gosu SHA256: 52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0, size1769900 bytes. Stored mode0644 locally, image mode0755. Never executed.

## Reproducible procedure

Tools: skopeo1.24.1; host Go1.27.1 darwin/arm64; pinned govulncheckv1.9.0.

1. `skopeo copy --override-os linux --override-arch amd64 docker://docker.io/library/postgres@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551 dir:/private/tmp/homecloud-d515-pg/image`
2. `python3 /private/tmp/homecloud-d515-pg/extract.py` verifies manifest/config/layer hashes and extracts the exact file without container startup.
3. `go version -m /private/tmp/homecloud-d515-pg/gosu-linux-amd64` produces gosu-buildinfo.txt. `file` identifies ELF x86-64 statically linked, not stripped.
4. Install `golang.org/x/vuln/cmd/govulncheck@v1.9.0`, with GOBIN/GOPATH/GOMODCACHE/GOCACHE confined to this temp tree, GOPROXY=https://proxy.golang.org and GOSUMDB=sum.golang.org. Go verified module checksum h1:12VaqnI9kJfqwRoPptxoqsUhQtdfrSbdksT7X/KY/sc=. The scanner executable SHA256 and buildinfo are preserved.
5. `govulncheck -mode binary -json -db https://vuln.go.dev /private/tmp/homecloud-d515-pg/gosu-linux-amd64` preserves unmodified streaming JSON and stderr/exit. A second and final run with `-show verbose` preserves official readable output. No exclusions, wrapper, VEX, custom DB, or suppression.
6. `govulncheck -mode extract /private/tmp/homecloud-d515-pg/gosu-linux-amd64` preserves exact extraction data (gosu-extract.blob). This is local metadata extraction, not another vulnerability scan. The representation is tool-internal; it is retained as supporting evidence rather than a stable integration format.
7. per-cve-binary-evidence.json joins all25 D513 H/C findings to exact official OSV records present in govulncheck output, emitted package/module findings, and extracted affected-symbol intersections. Each linked advisory also preserved under advisories/.

## Actual results and correct interpretation

Buildinfo: Go1.24.6, main github.com/tianon/gosu@v1.19.0, moby/sys/user@v0.1.0, x/sys@v0.1.0, CGO_ENABLED=0, GOOSlinux/GOARCHamd64. Embedded vcs.revision1.19 + epoch timestamp reflect upstream fake-git release metadata, not a source commit hash. They are not independent source provenance proof.

Govulncheck config: scan_mode=binary, scan_level=symbol, DBhttps://vuln.go.dev, db_last_modified2026-10-08T22:31:09Z. No stderr. Text exit0. JSON also exit0, but JSON exit0 alone never proves no findings.

Actual text: zero symbol vulnerabilities; 3 package-level vulnerabilities; 54 module-level vulnerabilities. JSON contains65 finding events (62 module-level events including repeated OSVs, 3 package-level events), representing57 unique OSVs. These must not be misreported as65 exploitable issues or zero raw findings.

The package findings are GO-2026-4970/os.Root, GO-2026-4864/Linux Root.Chmod, GO-2026-4602/Root FileInfo; none has an emitted vulnerable function match. os.Open/OpenFile are present; os.Root/OpenInRoot symbols are absent.

All25 preexisting Trivy H/C records are in the official govulncheck dataset. None has a symbol-level match. Critical GO-2026-4337/CVE-2025-68121 appears as stdlibv1.24.6 module-level evidence only; its affected crypto/tls package is absent from2962 extracted symbol records. Actual binary symbol metadata therefore supports that this critical TLS code is not linked into gosu. The binary has51 named packages; extracted main.SetupUser/main.main and os.Open/OpenFile demonstrate nonempty successful symbol extraction.

Binary scanning checks vulnerable-symbol presence and cannot reconstruct call graphs. It can overreport linked but unreachable functions. Reflection/unsafe and extraction limits prevent treating a negative result as a universal proof of safety. This result qualifies this exact gosu hash and exact amd64 image child against the recorded DB only; no broader gosu/PG/digest/architecture exception follows. It does not independently qualify PostgreSQL core/extensions or runtime configuration. Current Trivy raw1C/24H remains unchanged and gate remains blocked unless explicit individual decisions or actual remediation are authorized.

## Primary documentation

- https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck (binary analysis, symbol extraction, JSON exit semantics, limitations)
- https://pkg.go.dev/vuln/GO-2026-4337
- https://vuln.go.dev/ID/GO-2026-4337.json
- https://raw.githubusercontent.com/tianon/gosu/1.19/Dockerfile (upstream build metadata/fake-git, CGO_ENABLED0)

## Bounded corrections

First extraction attempt used hashlib.file_digest unavailable in host Python; replaced by chunked SHA256 and succeeded on attempt2. Local Go distribution has no nm tool; its empty output was not used as evidence. Replaced with official govulncheck extraction (successful,2962 symbol records). No loop or repeated scans followed. No Docker daemon, image execution, database, mini-PC, production service, repository or Git mutation occurred.

Evidence-generation correction: Python defaultdict queries initially created empty package keys; package-presence results have been recomputed exclusively from actual pkgSymbols records using a plain dictionary. crypto/tls is absent from the actual extracted records; no init/typelink-only crypto/tls record was found. This correction changes the named-package count, not the zero affected-symbol result.

Pinned extractor implementation verified in checksum-validated golang.org/x/vulnv1.9.0/internal/buildinfo/additions_scan.go: it reads Go PCLN metadata and explicitly collects inline-tree symbols as well as normal function records; missing symbol/PCLN data would fall back to module-only checking. This exact binary successfully emitted2962 symbol records and3 package-level results, so a blanket module-only fallback was not observed. This does not create a runtime call graph. Reflection caveat in public docs specifically describes source scanning; binary inspection should not be described as source reflection reachability analysis. Source snapshot retained as govulncheck-v1.9.0-extractor-source.go.txt. Primary permalink: https://go.googlesource.com/vuln/+/refs/tags/v1.9.0/internal/buildinfo/additions_scan.go
