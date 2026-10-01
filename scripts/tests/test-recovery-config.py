#!/usr/bin/env python3
"""External recovery contract tests; synthetic inputs, no persistent Docker data."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
from recovery_config import load_config, ConfigError

class Contract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.root = Path(self.tmp.name)
        self.compose = self.root/'compose.yml'; self.compose.write_text('services: {}\n')
        self.file = self.root/'recovery.env'
        self.secret = 'private-marker-$(touch /private/tmp/hc-config-injection)'
        self.values = dict(DB_NAME='custom_db', DB_USER='custom_user', DB_PASSWORD=self.secret,
                           COMPOSE_FILE=str(self.compose), COMPOSE_PROJECT_NAME='hc-contract')
        self.write()
        self.env = dict(PATH=os.environ['PATH'], HOMECLOUD_ENV_FILE=str(self.file))
    def tearDown(self): self.tmp.cleanup()
    def write(self):
        self.file.write_text(''.join(k+'='+v+'\n' for k,v in self.values.items())); self.file.chmod(0o600)
    def load(self, **updates):
        with patch.dict(os.environ, dict(self.env, **updates), clear=True): return load_config()
    def rejected(self, **updates):
        with self.assertRaises(ConfigError) as caught: self.load(**updates)
        self.assertNotIn(self.secret, str(caught.exception))
    def test_no_implicit_checkout_env(self):
        checkout=self.root/'checkout'; checkout.mkdir()
        (checkout/'.env').write_text('DB_PASSWORD=decoy-checkout-secret\n')
        import recovery_config
        with patch.object(recovery_config, 'REPO', checkout):
            self.assertEqual(self.load()['DB_PASSWORD'], self.secret)
            self.rejected(HOMECLOUD_ENV_FILE='')

    def test_external_literal_config(self):
        self.assertEqual(self.load()['DB_PASSWORD'], self.secret)
        self.assertFalse(Path('/private/tmp/hc-config-injection').exists())
    def test_precedence_and_empty_override(self):
        self.assertEqual(self.load(DB_USER='override')['DB_USER'], 'override')
        self.rejected(DB_PASSWORD='')
    def test_missing_relative_unreadable_and_world_readable(self):
        self.rejected(HOMECLOUD_ENV_FILE=str(self.root/'missing'))
        self.rejected(HOMECLOUD_ENV_FILE='relative.env')
        for mode in (0,0o644,0o666):
            self.file.chmod(mode); self.rejected()
        self.file.chmod(0o640); self.assertEqual(self.load()['DB_USER'],'custom_user')
    def test_symlink_and_checkout_rejected(self):
        link=self.root/'link'; link.symlink_to(self.file)
        self.rejected(HOMECLOUD_ENV_FILE=str(link))
        self.rejected(HOMECLOUD_ENV_FILE=str(SOURCE.parent/'.env'))
    def test_explicit_environment_mode_and_conflict(self):
        with patch.dict(os.environ, dict(self.values,HOMECLOUD_CONFIG_MODE='environment'),clear=True):
            self.assertEqual(load_config()['DB_USER'],'custom_user')
        self.rejected(HOMECLOUD_CONFIG_MODE='environment')
    def test_format_errors_redacted(self):
        for text in ('DB_PASSWORD='+self.secret+'\nDB_PASSWORD='+self.secret, 'BAD='+self.secret, 'DB_PASSWORD="'+self.secret):
            self.file.write_text(text); self.rejected()
    def test_identifier_and_absolute_compose_validation(self):
        self.rejected(DB_NAME="db';SELECT")
        self.rejected(COMPOSE_FILE='compose.yml')
        self.rejected(COMPOSE_PROJECT_NAME='Invalid project')
    def test_entrypoints_fail_closed_without_file(self):
        env=dict(PATH=os.environ['PATH'])
        entries=[['bash',str(SOURCE/'backup.sh'),'--yes'],['bash',str(SOURCE/'restore.sh'),'--validate-only'],['bash',str(SOURCE/'backup-production.sh')],['bash',str(SOURCE/'restore-offsite.sh'),'invalid'],[sys.executable,str(SOURCE/'reconcile.py'),'--db-user','custom_user','--db-name','custom_db','--storage-volume','unused','--backend-image','unused']]
        for args in entries:
            p=subprocess.run(args,cwd=self.root,env=env,capture_output=True,text=True)
            self.assertEqual(p.returncode,2, p.stdout+p.stderr)
            self.assertNotIn(self.secret,p.stdout+p.stderr)
    def test_shell_loader_and_compose_from_wrong_cwd(self):
        fake=self.root/'bin'; fake.mkdir()
        docker=fake/'docker'; docker.write_text('#!/bin/sh\nprintf "%s\\n" "$DB_USER" "$COMPOSE_FILE" "$@"\n'); docker.chmod(0o700)
        command='SCRIPT_DIR="$1"; source "$SCRIPT_DIR/recovery-config.sh"; docker compose ps'
        p=subprocess.run(['bash','-c',command,'test',str(SOURCE)],cwd=self.root,env=dict(self.env,PATH=str(fake)+':'+os.environ['PATH']),capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(p.stdout.splitlines(),['custom_user',str(self.compose),'compose','--env-file','/dev/null','ps'])
        self.assertNotIn(self.secret,p.stdout+p.stderr)
    def test_reconcile_same_config_and_cli_mismatch(self):
        p=subprocess.run([sys.executable,str(SOURCE/'reconcile.py'),'--db-user','wrong','--db-name','custom_db','--storage-volume','unused','--backend-image','unused'],env=self.env,cwd=self.root,capture_output=True,text=True)
        self.assertEqual(p.returncode,2); self.assertNotIn(self.secret,p.stderr)

if __name__=='__main__': unittest.main()
