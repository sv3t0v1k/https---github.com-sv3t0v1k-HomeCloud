#!/usr/bin/env python3
"""Require every Fast and Integration job in the current PR run."""
import argparse
import json
import sys

REQUIRED = {'pr-fast-backend', 'backend', 'frontend', 'configuration', 'secrets',
            'recovery-qualification'}


def validate(results, event_name='pull_request'):
    if event_name not in ('pull_request', 'push'):
        raise ValueError('Unsupported Fast/Integration event')
    if not isinstance(results, dict) or set(results) != REQUIRED:
        raise ValueError('Missing or unexpected Fast/Integration result')
    for name, job in results.items():
        # This PR-only qualification has no publication/TEST-push role. All
        # original five jobs remain mandatory on both supported events.
        if (event_name == 'push' and name == 'recovery-qualification'
                and isinstance(job, dict) and job.get('result') == 'skipped'):
            continue
        if not isinstance(job, dict) or job.get('result') != 'success':
            status = job.get('result') if isinstance(job, dict) else 'invalid'
            raise ValueError(f'Fast/Integration job failed or skipped: {name}={status}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', required=True)
    parser.add_argument('--event-name', choices=('pull_request', 'push'), required=True)
    args = parser.parse_args()
    try:
        validate(json.loads(args.results), args.event_name)
    except (ValueError, json.JSONDecodeError) as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
