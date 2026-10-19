#!/usr/bin/env python3
"""Pure synthetic integrity, backup inventory and measurement primitives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def payload(event_id):
    require(isinstance(event_id, int) and 1 <= event_id <= 100, "synthetic event ID required")
    return (f"D513 synthetic event {event_id:04d}\n" * 31).encode()


def inventory(root):
    root = Path(root)
    require(root.is_dir() and root.resolve() == root and root != Path('/'), "regular synthetic root required")
    info = root.stat()
    result = {'.': dict(kind='directory',mode=stat.S_IMODE(info.st_mode),uid=info.st_uid,gid=info.st_gid)}

    def visit(directory):
        for entry in sorted(os.scandir(directory), key=lambda e: e.name):
            path = Path(entry.path)
            info = entry.stat(follow_symlinks=False)
            name = str(path.relative_to(root))
            require(not stat.S_ISLNK(info.st_mode) and info.st_nlink <= 1 or
                    stat.S_ISDIR(info.st_mode), "symlink or hardlink in synthetic tree")
            require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), "special file in synthetic tree")
            record = dict(mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid)
            if stat.S_ISDIR(info.st_mode):
                record['kind'] = 'directory'
                visit(path)
            else:
                require(info.st_size <= 64 * 1024 * 1024, "oversized synthetic file")
                record.update(kind='file', size=info.st_size, sha256=sha(path.read_bytes()))
            result[name] = record
    visit(root)
    return result


def validate_files(root, rows, generation):
    root = Path(root)
    require(root.is_dir() and root.resolve() == root and not root.is_symlink(), 'HDD root must be regular')
    owner = root.stat()
    require(stat.S_IMODE(owner.st_mode) == 0o700, 'HDD directory permissions changed')
    require(isinstance(rows, list) and rows, "missing DB event rows")
    marker = root / 'generation.json'
    require(marker.is_file() and not marker.is_symlink(), "missing HDD generation")
    info=marker.stat()
    require(info.st_size <= 4096 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600
            and (info.st_uid,info.st_gid)==(owner.st_uid,owner.st_gid), 'unsafe generation marker metadata')
    require(json.loads(marker.read_text()) == dict(generation=generation), "DB/HDD generation mismatch")
    expected = {'generation.json'}
    ids = set()
    for row in rows:
        event_id = row['event_id']
        require(event_id not in ids and row['generation'] == generation, "duplicate ID/wrong DB generation")
        ids.add(event_id)
        name = f'event-{event_id:04d}.bin'
        require(row['path'] == name and row['owner_name'] == 'd513_owner', "unsafe reference or owner")
        expected.add(name)
        path = root / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1, "missing/linked HDD file")
        info = path.stat()
        require((info.st_uid,info.st_gid)==(owner.st_uid,owner.st_gid) and
                stat.S_IMODE(info.st_mode)==0o600 and info.st_size <= 65536, 'HDD owner/mode/size changed')
        data = path.read_bytes()
        require(data == payload(event_id) and len(data) == row['size'] and sha(data) == row['sha256'],
                "file bytes/size/hash mismatch")
    require({entry.name for entry in root.iterdir()} == expected, "unreferenced HDD files")
    return dict(events=len(rows), bytes=sum(row['size'] for row in rows), generation=generation)


def verify_backup(actual, manifest):
    require(set(manifest) == {'db', 'hdd', 'logical'}, "incomplete backup manifest")
    require(actual == manifest and manifest['db'] and manifest['hdd'] and manifest['logical'],
            "backup corrupt or incomplete")


def measurements(before, restored, failure_ns, ready_ns, inflight):
    require(before and restored and ready_ns >= failure_ns, "invalid measurement endpoints")
    require(isinstance(inflight,int) and inflight >= 0, 'invalid inflight count')
    require(all(isinstance(row['confirmed_ns'],int) and row['confirmed_ns'] <= failure_ns for row in before),
            'confirmed event occurs after failure')
    by_id = {row['event_id']: row for row in before}
    restored_ids = {row['event_id'] for row in restored}
    require(len(by_id) == len(before) and len(restored_ids) == len(restored), "duplicate measurement event")
    require(restored_ids <= by_id.keys(), "restore contains unconfirmed events")
    for row in restored:
        require(row == by_id[row['event_id']], "restored event identity changed")
    lost = [row for row in before if row['event_id'] not in restored_ids]
    require(all(row['confirmed_ns'] > max(r['confirmed_ns'] for r in restored) for row in lost),
            "restore has holes in confirmed event sequence")
    delta = max(row['confirmed_ns'] for row in before) - max(row['confirmed_ns'] for row in restored)
    require(delta >= 0, "RPO clock order invalid")
    return dict(rpo_seconds=delta / 1e9, rto_seconds=(ready_ns-failure_ns)/1e9,
                failure_ns=failure_ns,integrity_ready_ns=ready_ns,
                latest_confirmed_ns=max(row['confirmed_ns'] for row in before),
                latest_restored_ns=max(row['confirmed_ns'] for row in restored),
                lost_events=len(lost), lost_bytes=sum(row['size'] for row in lost),
                inflight_events=inflight, endpoint='gate+DB readiness+full DB/HDD integrity',
                scope='SYNTHETIC_READ_ONLY_AVAILABILITY')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['inventory', 'check'])
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    if args.operation == 'inventory':
        print(json.dumps(inventory(args.root), sort_keys=True))
    else:
        import sys
        request = json.load(sys.stdin)
        require((args.root.stat().st_uid,args.root.stat().st_gid)==(70,70),'synthetic HDD UID/GID mismatch')
        print(json.dumps(validate_files(args.root, request['rows'], request['generation']), sort_keys=True))


if __name__ == '__main__':
    main()
