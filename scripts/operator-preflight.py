#!/usr/bin/env python3
"""Read-only presence/consistency gate. No network, Docker, credential tests or GO."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXTERNAL = ('linux_target', 'dns_public_ca', 'registry', 'alert_recipient',
            'offsite', 'custody', 'host_browser_operator_acceptance', 'external_watchdog',
            'maintenance_barrier', 'production_volume_recovery')
APPROVALS = ('rpo', 'rto', 'backup_cadence', 'launch_dataset', 'maintenance_window')

def private_file(value):
    p = Path(value)
    if not p.is_absolute() or any(x.is_symlink() for x in (p, *p.parents)):
        raise ValueError()
    if p.resolve().is_relative_to(ROOT) or not p.is_file() or p.stat().st_mode & 0o077:
        raise ValueError()
    if p.parent.stat().st_mode & 0o077 or p.stat().st_uid != os.geteuid():
        raise ValueError()
    return p

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

def check(args):
    checks = []
    def record(name, call):
        try: call(); checks.append({'check': name, 'status': 'PASS'})
        except Exception: checks.append({'check': name, 'status': 'MISSING_OR_INVALID_LOCAL_CONFIG'})
    env = {}; scheduler = {}; policy = {}
    def recovery():
        private_file(args.env_file)
        saved = os.environ.copy()
        try:
            os.environ.clear(); os.environ['HOMECLOUD_ENV_FILE'] = args.env_file
            env.update(module('recovery_config', 'recovery_config.py').load_config())
        finally:
            os.environ.clear(); os.environ.update(saved)
        for key in ('JWT_SECRET', 'JWT_REFRESH_SECRET', 'PUBLIC_HOST', 'TLS_CERT_DIR',
                    'ACME_WEBROOT_DIR', 'BACKUP_PRODUCTION_DIR', 'BACKUP_OFFSITE_DIR',
                    'BACKUP_AGE_RECIPIENTS_FILE'):
            if not env.get(key): raise ValueError()
        if env.get('BACKUP_WRITE_BARRIER_CONFIRMED'): raise ValueError()
        for key in ('TLS_CERT_DIR', 'ACME_WEBROOT_DIR', 'BACKUP_PRODUCTION_DIR', 'BACKUP_OFFSITE_DIR'):
            p = Path(env[key])
            if not p.is_absolute() or not p.is_dir() or p.resolve().is_relative_to(ROOT): raise ValueError()
        tls = Path(env['TLS_CERT_DIR']) / 'current'
        if not (tls/'fullchain.pem').is_file() or not (tls/'privkey.pem').is_file(): raise ValueError()
        state = Path(env['TLS_CERT_DIR'])
        if state.is_symlink() or state.stat().st_mode & 0o077: raise ValueError()
        if not tls.is_symlink() or tls.resolve().parent != (state/'versions').resolve(): raise ValueError()
        for directory in (state/'versions', tls.resolve()):
            if directory.stat().st_mode & 0o077 or directory.stat().st_uid != os.geteuid(): raise ValueError()
        key = tls/'privkey.pem'
        if key.is_symlink() or key.stat().st_mode & 0o077 or key.stat().st_uid != os.geteuid(): raise ValueError()
        for name in ('BACKUP_PRODUCTION_DIR', 'BACKUP_OFFSITE_DIR'):
            directory = Path(env[name])
            if any(x.is_symlink() for x in (directory, *directory.parents)): raise ValueError()
            if directory.stat().st_mode & 0o077: raise ValueError()
        private_file(env['BACKUP_AGE_RECIPIENTS_FILE'])
        # Recovery key belongs to custodian, never to writer/scheduler config.
        if env.get('BACKUP_AGE_IDENTITY_FILE'): raise ValueError()
    record('external_recovery_config_paths_permissions', recovery)
    def manifest():
        command = ['node', '-e', 'const fs=require("node:fs"),m=require(process.argv[1]);m.shape(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));',
                   str(ROOT/'scripts/release-manifest.cjs'), args.manifest]
        if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode: raise ValueError()
    record('immutable_manifest_syntax_pair_hash', manifest)
    def scheduled():
        private_file(args.scheduler)
        scheduler.update(module('scheduled_operations', 'scheduled-operations.py').config(args.scheduler))
        if scheduler.get('allow_test_http'): raise ValueError()
        for key in ('recovery_env', 'backup_wrapper'): private_file(scheduler[key])
        if Path(scheduler['recovery_env']).resolve() != Path(args.env_file).resolve(): raise ValueError()
        if not os.access(scheduler['backup_wrapper'], os.X_OK): raise ValueError()
        if Path(scheduler['backup_marker']) != Path(env['BACKUP_PRODUCTION_DIR'])/'last-backup-success.json': raise ValueError()
        c = scheduler['cert_args']
        if c['hostname'] != env['PUBLIC_HOST'] or Path(c['state-dir']) != Path(env['TLS_CERT_DIR']): raise ValueError()
        if Path(c['webroot']) != Path(env['ACME_WEBROOT_DIR']) or not Path(c['acme-dir']).is_dir(): raise ValueError()
        if not c.get('container') or not c.get('cert-name'): raise ValueError()
        for p in (ROOT/'ops/systemd').glob('homecloud-*'):
            if not p.is_file(): raise ValueError()
        if len(list((ROOT/'ops/systemd').glob('homecloud-*'))) != 8: raise ValueError()
    record('scheduler_config_consistency_units', scheduled)
    def acknowledgements():
        policy.update(json.loads(private_file(args.qualification).read_text()))
        if set(policy) != {'external', 'approvals'}: raise ValueError()
        for group, keys in (('external', EXTERNAL), ('approvals', APPROVALS)):
            if set(policy[group]) != set(keys): raise ValueError()
            for entry in policy[group].values():
                if set(entry) != {'qualified', 'record'} or type(entry['qualified']) is not bool: raise ValueError()
                if entry['qualified']:
                    p = Path(entry['record'])
                    if not p.is_absolute() or not p.is_file() or p.stat().st_size == 0: raise ValueError()
                elif entry['record'] != '': raise ValueError()
    record('qualification_record_schema', acknowledgements)
    missing = any(c['status'] != 'PASS' for c in checks)
    external = [key for key in EXTERNAL if policy.get('external', {}).get(key, {}).get('qualified') is not True]
    approvals = [key for key in APPROVALS if policy.get('approvals', {}).get(key, {}).get('qualified') is not True]
    print(json.dumps({'checks': checks, 'external_input_required': external,
                     'owner_approval_required': approvals, 'overall_production_readiness': 'NOT_READY',
                     'boundary': 'presence only; operator records require independent review; no GO authorization'}, indent=2))
    return 2 if missing else 3 if external else 4 if approvals else 0

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file', required=True); p.add_argument('--manifest', required=True)
    p.add_argument('--scheduler', required=True); p.add_argument('--qualification', required=True)
    sys.exit(check(p.parse_args()))
