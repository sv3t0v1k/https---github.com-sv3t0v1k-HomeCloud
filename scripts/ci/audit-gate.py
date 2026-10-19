#!/usr/bin/env python3
"""npm audit must be a valid, non-empty response; high/critical block release."""
import json
import sys


def check(report):
    counts = report['metadata']['vulnerabilities']
    levels = ('info', 'low', 'moderate', 'high', 'critical', 'total')
    if 'error' in report or any(type(counts.get(x)) is not int or counts[x] < 0 for x in levels):
        raise ValueError('invalid audit report')
    if counts['total'] != sum(counts[x] for x in levels[:-1]):
        raise ValueError('inconsistent audit counts')
    print(json.dumps(counts, sort_keys=True))
    return counts['high'] == 0 and counts['critical'] == 0


if __name__ == '__main__':
    try:
        accepted = check(json.load(open(sys.argv[1])))
    except (KeyError, ValueError, OSError, IndexError):
        sys.exit('BLOCKED: npm audit response unavailable or malformed')
    if not accepted:
        sys.exit('BLOCKED: high/critical advisories require remediation and independent review')
