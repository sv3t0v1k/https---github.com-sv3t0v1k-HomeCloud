#!/usr/bin/env python3
"""Report runtime and additional dev dependency findings without changing the full audit gate."""
import json
from pathlib import Path
import sys

LEVELS = ("info", "low", "moderate", "high", "critical", "total")


def counts(path):
    report = json.loads(Path(path).read_text())
    value = report["metadata"]["vulnerabilities"]
    if "error" in report or any(type(value.get(k)) is not int or value[k] < 0 for k in LEVELS):
        raise ValueError(f"Invalid npm audit report: {path}")
    if value["total"] != sum(value[k] for k in LEVELS[:-1]):
        raise ValueError(f"Inconsistent npm audit counts: {path}")
    return {k: value[k] for k in LEVELS}


def summarize(runtime, full):
    if any(full[k] < runtime[k] for k in LEVELS):
        raise ValueError("Runtime findings exceed full dependency findings")
    return {
        "runtime": runtime,
        "dev_additional": {k: full[k] - runtime[k] for k in LEVELS},
        "full": full,
        "gate": "BLOCKED" if full["high"] or full["critical"] else "PASS",
        "note": "dev_additional is the count difference; full audit remains the authoritative gate",
    }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Usage: audit-domains.py runtime.json full.json summary.json")
        result = summarize(counts(sys.argv[1]), counts(sys.argv[2]))
        Path(sys.argv[3]).write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
        print(json.dumps(result, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        sys.exit(f"BLOCKED: {error}")
