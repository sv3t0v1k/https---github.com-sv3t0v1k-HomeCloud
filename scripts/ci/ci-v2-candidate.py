#!/usr/bin/env python3
"""Reject a PR candidate whose HEAD or base changed during qualification."""
import argparse
import json
from pathlib import Path
import re
import sys

SHA = re.compile(r'[a-f0-9]{40}\Z')


def validate(event, live, checkout, qualification=None, run_id=None, attempt=None):
    original = event['pull_request']
    event_head, event_base = original['head']['sha'], original['base']['sha']
    live_head, live_base = live['head']['sha'], live['base']['sha']
    if not all(isinstance(value, str) and SHA.fullmatch(value)
               for value in (event_head, event_base, live_head, live_base, checkout)):
        raise ValueError('Invalid candidate SHA')
    if checkout != event_head or (live_head, live_base) != (event_head, event_base):
        raise ValueError('PR HEAD or base changed after qualification started')
    if qualification is not None:
        if (qualification.get('source_commit') != checkout
                or qualification.get('status') != 'PASS'
                or qualification.get('coverage') != 'COVERED'
                or qualification.get('errors') != []
                or qualification.get('ci') != {'run_id': run_id, 'attempt': attempt}):
            raise ValueError('Missing, blocked, stale or different-run qualification')
    return {'head_sha': event_head, 'base_sha': event_base}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event', required=True)
    parser.add_argument('--live', required=True)
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--qualification')
    parser.add_argument('--run-id')
    parser.add_argument('--attempt')
    args = parser.parse_args()
    try:
        qualification = json.loads(Path(args.qualification).read_text()) if args.qualification else None
        result = validate(json.loads(Path(args.event).read_text()), json.loads(Path(args.live).read_text()),
                          args.checkout, qualification, args.run_id, args.attempt)
        print(json.dumps(result, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
