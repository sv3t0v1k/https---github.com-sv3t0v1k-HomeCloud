#!/usr/bin/env python3
"""Remove only the unused .NET SDK on disposable GitHub-hosted Linux runners."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess


TARGET = '/usr/share/dotnet'
FORMAT = 'homecloud-hosted-runner-minimization-v1'


def validate(record, source, github):
    if (record.get('format') != FORMAT or record.get('source_commit') != source
            or record.get('github') != github
            or record.get('removed_paths') != [TARGET]
            or record.get('absent_after') is not True
            or record.get('status') != 'REMOVED_BEFORE_WORKLOAD'
            or record.get('rootfs_scope_changed') is not False):
        raise ValueError('Missing or mismatched hosted runner minimization evidence')


def context(env):
    if (env.get('GITHUB_ACTIONS') != 'true'
            or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or platform.system() != 'Linux' or platform.machine() != 'x86_64'
            or Path('/.dockerenv').exists()):
        raise ValueError('Minimization requires a disposable GitHub-hosted Linux amd64 host')
    workspace = Path(env['GITHUB_WORKSPACE'])
    temp = Path(env['RUNNER_TEMP'])
    if (not str(workspace).startswith('/home/runner/work/')
            or not str(temp).startswith('/home/runner/work/')
            or workspace.resolve() != workspace or temp.resolve() != temp
            or not all(env.get(key, '') for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'))):
        raise ValueError('Unexpected disposable runner workspace/identity')
    return workspace, temp


def main():
    workspace, temp = context(os.environ)
    target = Path(TARGET)
    # Refuse changed layouts instead of following a provider-created symlink.
    if target.is_symlink() or target.resolve() != target:
        raise ValueError('Refusing a symlinked .NET SDK path')
    present = target.exists()
    if present and not target.is_dir():
        raise ValueError('Unexpected .NET SDK file type')
    # The hosted SDK is installed outside dpkg. A future package-owned SDK needs
    # package-manager removal and a new review, never stale installed metadata.
    ownership = subprocess.run(['dpkg-query', '-S', TARGET+'/*'], text=True, capture_output=True)
    if ownership.returncode != 1 or ownership.stdout.strip():
        raise ValueError('Unexpected package-owned .NET SDK; manual review required')
    before = sorted(entry.name for entry in target.iterdir()) if present else []
    size = subprocess.check_output(['du', '-sk', TARGET], text=True).strip() if present else None
    if present:
        subprocess.run(['sudo', '--', 'rm', '-rf', '--', TARGET], check=True)
    if target.exists() or target.is_symlink():
        raise ValueError('Unused .NET SDK removal failed')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, text=True).strip()
    github = dict(run_id=os.environ['GITHUB_RUN_ID'], run_attempt=os.environ['GITHUB_RUN_ATTEMPT'],
                  sha=os.environ['GITHUB_SHA'], job=os.environ['GITHUB_JOB'],
                  runner_environment=os.environ['RUNNER_ENVIRONMENT'])
    record = dict(format=FORMAT, observed_at=datetime.now(timezone.utc).isoformat(),
                  source_commit=source, github=github, removed_paths=[TARGET],
                  existed_before=present, entries_before=before, du_kib_before=size,
                  absent_after=True, status='REMOVED_BEFORE_WORKLOAD', rootfs_scope_changed=False,
                  justification='Workflow uses Node/Python/Docker/shell actions; no .NET workload. '
                                'All remaining host files keep mandatory full-rootfs coverage.')
    validate(record, source, github)
    destination = temp/'homecloud-runner-minimization.json'
    with destination.open('x') as stream:
        stream.write(json.dumps(record, indent=2)+'\n')
    print(json.dumps(record, sort_keys=True))


if __name__ == '__main__':
    main()
