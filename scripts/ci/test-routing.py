#!/usr/bin/env python3
"""Fail-closed Jest suite routing and result verification for CI."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
CRITICAL = {
    "src/auth/auth.lifecycle.spec.ts",
    "src/auth/auth.security-boundary.spec.ts",
    "src/files/files.service.critical.spec.ts",
    "src/files/archive-downloads.spec.ts",
    "src/uploads/uploads.service.spec.ts",
    "src/uploads/secure-filesystem.spec.ts",
    "src/uploads/ssd-finalization-filesystem.spec.ts",
    "src/sharing/sharing.service.spec.ts",
    "src/sharing/sharing.folder.zip.spec.ts",
    "src/uploads/durable-upload-whole-sha256.postgres.spec.ts",
    "src/uploads/legacy-publication.postgres.spec.ts",
    "src/files/security-ownership.postgres.spec.ts",
}
FRONTEND_CRITICAL = {
    "src/auth/SessionContext.test.tsx",
    "src/routing/router-security.test.tsx",
    "src/files/uploadQueue.test.ts",
    "src/files/wholeSha256.test.ts",
    "src/files/download.test.ts",
    "src/files/FileBrowserPage.test.tsx",
    "src/sharing/PublicSharePage.test.tsx",
    "src/sharing/PublicUploadPanel.test.tsx",
}


def routes():
    discovered = {p.relative_to(BACKEND).as_posix() for base in ("src", "bench")
                  for p in (BACKEND / base).rglob("*.spec.ts")}
    if not CRITICAL <= discovered:
        raise ValueError(f"Missing critical suites: {sorted(CRITICAL - discovered)}")
    integration = {p for p in discovered if p.endswith(".postgres.spec.ts") or p.startswith("bench/")}
    unit = discovered - integration
    if not unit or not integration or unit & integration or unit | integration != discovered:
        raise ValueError("Incomplete or overlapping Jest routes")
    if not any(p.endswith(".postgres.spec.ts") for p in integration):
        raise ValueError("PostgreSQL route is empty")
    frontend = {p.relative_to(FRONTEND).as_posix() for p in (FRONTEND / "src").rglob("*.test.ts")}
    frontend |= {p.relative_to(FRONTEND).as_posix() for p in (FRONTEND / "src").rglob("*.test.tsx")}
    if not FRONTEND_CRITICAL <= frontend:
        raise ValueError(f"Missing critical frontend suites: {sorted(FRONTEND_CRITICAL - frontend)}")
    return {"unit": sorted(unit), "integration": sorted(integration), "frontend": sorted(frontend)}


def verify(profile, report):
    expected = set(routes()[profile])
    base = FRONTEND if profile == "frontend" else BACKEND
    if report.get("success") is not True:
        raise ValueError("Jest did not succeed")
    results = report.get("testResults")
    if not isinstance(results, list):
        raise ValueError("Missing Jest suite results")
    actual = {}
    for result in results:
        path = Path(result["name"]).resolve().relative_to(base.resolve()).as_posix()
        if path in actual:
            raise ValueError(f"Duplicate suite: {path}")
        actual[path] = result
    if set(actual) != expected:
        raise ValueError(f"Suite mismatch: missing={sorted(expected - set(actual))}; unexpected={sorted(set(actual) - expected)}")
    for path, result in actual.items():
        assertions = result.get("assertionResults")
        if result.get("status") != "passed" or not assertions or any(a.get("status") != "passed" for a in assertions):
            raise ValueError(f"Failed, empty or skipped suite: {path}")
    print(json.dumps({"profile": profile, "suites": len(actual),
                      "assertions": sum(len(r["assertionResults"]) for r in actual.values())}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("list", "verify"))
    parser.add_argument("profile", choices=("unit", "integration", "frontend"))
    parser.add_argument("report", nargs="?")
    args = parser.parse_args()
    try:
        if args.command == "list":
            if args.report:
                raise ValueError("list takes no report")
            print("\n".join(routes()[args.profile]))
        else:
            if not args.report:
                raise ValueError("verify requires a Jest report")
            verify(args.profile, json.loads(Path(args.report).read_text()))
    except (ValueError, KeyError, OSError, TypeError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
