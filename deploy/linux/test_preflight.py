#!/usr/bin/env python3
"""Изолированные D3 fixtures: без Docker API, mounts, БД и target данных."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('preflight.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
ROOT = Path(os.environ.get('HOMECLOUD_TEST_ROOT', '/opt/homecloud'))
PROD = Path(os.environ.get('HOMECLOUD_TEST_PROD', str(ROOT / 'docker-compose.production.yml')))


class ConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Отдельный synthetic env: реальный checkout .env не читается и не выводится.
        values = dict(COMPOSE_PROJECT_NAME='homecloud-d3-fixture', DB_PASSWORD='a'*64,
                      JWT_SECRET='b'*64, JWT_REFRESH_SECRET='c'*64, REDIS_PASSWORD='d'*64,
                      PUBLIC_HOST='cloud.example.invalid', SSD_DB_DIR='/srv/homecloud-ssd/postgres',
                      HDD_STORAGE_DIR='/srv/homecloud-hdd/storage', TLS_CERT_DIR='/tmp/d3-tls',
                      ACME_WEBROOT_DIR='/tmp/d3-acme', RELEASE_BACKEND_IMAGE='homecloud-backend:d3-fixture',
                      RELEASE_FRONTEND_IMAGE='homecloud-frontend:d3-fixture',
                      PUBLIC_HTTP_PORT='18080', PUBLIC_HTTPS_PORT='18443', PUBLIC_ORIGIN='https://cloud.example.invalid:18443',
                      INGRESS_SUBNET='172.29.0.0/24', INGRESS_PROXY_IP='172.29.0.10',
                      BACKEND_PROXY_SUBNET='172.30.0.0/24', FRONTEND_PROXY_IP='172.30.0.10')
        with tempfile.NamedTemporaryFile(mode='w') as env:
            env.write(''.join(k+'='+v+'\n' for k,v in values.items()))
            env.flush()
            r = subprocess.run(['docker','compose','--env-file',env.name,'-f',str(ROOT/'docker-compose.yml'),
                                '-f',str(PROD),'config','--format','json'],
                               capture_output=True,text=True,
                               env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'COMPOSE_DISABLE_ENV_FILE':'1'})
            if r.returncode:
                raise RuntimeError('Synthetic Compose config failure (вывод скрыт)')
            cls.config=json.loads(r.stdout)
        cls.inventory=json.loads(Path(__file__).with_name('host-disks.example.json').read_text())

    def test_actual_compose_merge(self):
        p.check_config(self.config,self.inventory)

    def refusal(self, edit):
        c=copy.deepcopy(self.config)
        edit(c)
        with self.assertRaises(p.Refusal):
            p.check_config(c,self.inventory)

    def test_restart_bypass(self):
        self.refusal(lambda c:c['services']['db'].update(restart='always'))
    def test_ssd_on(self):
        self.refusal(lambda c:c['services']['backend']['environment'].update(UPLOAD_SSD_ENABLED='true'))
    def test_empty_mapping_also_refused(self):
        self.refusal(lambda c:c['services']['backend']['environment'].update(UPLOAD_SSD_PATH=''))
    def test_fallback_creation(self):
        self.refusal(lambda c:c['services']['backend']['volumes'][0]['bind'].update(create_host_path=True))
    def test_wrong_mapping(self):
        self.refusal(lambda c:c['services']['db']['volumes'][0].update(source='/srv/system/postgres'))
    def test_mac_port_leak(self):
        self.refusal(lambda c:c['services']['frontend'].update(ports=[{'published':'8080'}]))
    def test_wrong_gid(self):
        self.refusal(lambda c:c['services']['backend'].update(user='1001:1001'))
    def test_mutable_dev_image(self):
        self.refusal(lambda c:c['services']['backend'].update(image='homecloud-backend:dev'))
    def test_registry_port_without_tag(self):
        self.refusal(lambda c:c['services']['backend'].update(image='registry:5000/backend'))
    def test_memory_overcommit(self):
        self.refusal(lambda c:c['services']['backend'].update(mem_limit=8*1024**3))

    def test_missing_writer_command(self):
        self.refusal(lambda c:c['services']['db'].pop('command'))
    def test_missing_gate(self):
        self.refusal(lambda c:c['services']['db'].pop('entrypoint'))
    def test_writable_gate(self):
        self.refusal(lambda c:c['services']['backend']['volumes'][1].update(read_only=False))
    def test_preview_project(self):
        self.refusal(lambda c:c.update(name='homecloud-preview'))
    def test_privileged_writer(self):
        self.refusal(lambda c:c['services']['db'].update(privileged=True))
    def test_external_network(self):
        self.refusal(lambda c:c['networks']['app_network'].update(external=True))


class DiskTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.spec=dict(mount=str(Path(self.tmp.name).resolve()),uuid='real-uuid',serial='real-serial',min_free_bytes=1,min_free_inodes=1)
        self.mount=dict(target=str(Path(self.tmp.name).resolve()),source='/dev/fixture1',fstype='ext4',uuid='real-uuid',options='rw,relatime')
        self.block=dict(path='/dev/fixture1',type='part',children=[dict(path='/dev/fixture',type='disk',serial='real-serial')])

    def run_disk(self):
        def cmd(*args):
            if args[0]=='findmnt':return json.dumps({'filesystems':[self.mount]})
            if args[0]=='lsblk':return json.dumps({'blockdevices':[self.block]})
            raise AssertionError('Непредусмотренная команда')
        with patch.object(p,'command',side_effect=cmd):
            return p.check_disk(self.spec)
    def test_verified_disk(self):
        self.assertEqual(self.run_disk(),'/dev/fixture')
    def test_missing_mount_existing_directory(self):
        self.mount['target']='/'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_wrong_uuid(self):
        self.mount['uuid']='wrong'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_wrong_serial(self):
        self.block['children'][0]['serial']='wrong'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_readonly_mount(self):
        self.mount['options']='ro,relatime'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_network_fs(self):
        self.mount['fstype']='nfs'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_insufficient_capacity(self):
        self.spec['min_free_bytes']=10**30
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_insufficient_inodes(self):
        self.spec['min_free_inodes']=10**30
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_unqualified_lvm(self):
        self.block['type']='lvm'
        with self.assertRaises(p.Refusal):self.run_disk()
    def test_symlink_mountpoint(self):
        link=Path(str(Path(self.tmp.name).resolve()))/'link';link.symlink_to('/tmp')
        self.spec['mount']=str(link)
        with self.assertRaises(p.Refusal):self.run_disk()


class DataLayoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        self.data=self.root/'postgres'
        self.data.mkdir(mode=0o700)
        self.disk=dict(mount=str(self.root),uuid='real-uuid')
        self.mounts=[]
    def run_data(self):
        def cmd(*args):
            if '--list' in args:return json.dumps({'filesystems':self.mounts})
            return json.dumps({'filesystems':[dict(target=str(self.root),uuid='real-uuid')]})
        with patch.object(p,'command',side_effect=cmd):
            p.check_data_directory(str(self.data),self.disk,os.getuid(),os.getgid())
    def test_plain_data(self):self.run_data()
    def test_pg_wal_nested_mount(self):
        self.mounts=[dict(target=str(self.data/'pg_wal'))]
        with self.assertRaises(p.Refusal):self.run_data()
    def test_storage_nested_file_mount(self):
        self.mounts=[dict(target=str(self.data/'user'/'file'))]
        with self.assertRaises(p.Refusal):self.run_data()
    def test_data_wrong_owner(self):
        with patch.object(p,'command',return_value=json.dumps({'filesystems':[dict(target=str(self.root),uuid='real-uuid')]})):
            with self.assertRaises(p.Refusal):
                p.check_data_directory(str(self.data),self.disk,os.getuid()+1,os.getgid())
    def test_data_unsafe_mode(self):
        self.data.chmod(0o777)
        with self.assertRaises(p.Refusal):self.run_data()
    def test_external_wal_symlink(self):
        (self.data/'pg_wal').symlink_to('/tmp')
        with self.assertRaises(p.Refusal):p.check_postgres_layout(str(self.data))
    def test_external_tablespace(self):
        (self.data/'pg_tblspc').mkdir()
        (self.data/'pg_tblspc'/'42').symlink_to('/tmp')
        with self.assertRaises(p.Refusal):p.check_postgres_layout(str(self.data))
    def test_default_pg_layout(self):
        (self.data/'pg_wal').mkdir()
        (self.data/'pg_tblspc').mkdir()
        p.check_postgres_layout(str(self.data))


class UnitTests(unittest.TestCase):
    def test_same_authority_and_stop_on_start_failure(self):
        unit=Path(__file__).with_name('homecloud.service').read_text()
        commands=[line for line in unit.splitlines() if line.startswith('Exec')]
        self.assertEqual(len(commands),3)
        for line in commands:self.assertIn('/usr/bin/env -i PATH=',line)
        self.assertIn('ExecStopPost=',unit)
        self.assertIn('BindsTo=srv-homecloud\\x2dssd.mount srv-homecloud\\x2dhdd.mount',unit)
        self.assertIn('RemainAfterExit=yes',unit)


if __name__=='__main__':
    unittest.main()
