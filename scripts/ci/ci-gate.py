#!/usr/bin/env python3
"""Validate required CI job results without accepting unexpected skips."""
import argparse
import json
import sys

REQUIRED = {'pr-fast-backend', 'backend', 'frontend', 'configuration', 'image-build', 'provenance-pair',
            'base-image-scan', 'security', 'secrets', 'support-images', 'policy-coverage'}
PROFILES = {'pull-request', 'main', 'release'}


def validate(results, profile):
    if profile not in PROFILES:
        raise ValueError('Unknown CI qualification profile')
    if not isinstance(results, dict) or set(results) != REQUIRED:
        raise ValueError('Required CI job result set is incomplete or unexpected')
    for name, job in results.items():
        if not isinstance(job, dict):
            raise ValueError('Invalid job result: '+name)
        status = job.get('result')
        if status == 'success':
            continue
        if profile == 'pull-request' and name == 'base-image-scan' and status == 'skipped':
            continue
        raise ValueError(f'CI gate failed or unexpectedly skipped: {name}={status}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--results', required=True)
    args = parser.parse_args()
    try:
        validate(json.loads(args.results), args.profile)
    except (json.JSONDecodeError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
