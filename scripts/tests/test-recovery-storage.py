#!/usr/bin/env python3
"""D1 storage identity fixtures. Docker is mocked; no daemon is accessed."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
BASELINE = '--baseline' in sys.argv
if BASELINE:
    sys.argv.remove('--baseline')
else:
    sys.path.insert(0, str(SCRIPTS))
    import recovery_storage as storage
    import reconcile

BASELINE_ROOT = None
if BASELINE:
    marker = sys.argv.index('--baseline-root')
    BASELINE_ROOT = Path(sys.argv[marker + 1]) / 'scripts'
    del sys.argv[marker:marker + 2]
    BASELINE_BACKUP = (BASELINE_ROOT / 'backup.sh').read_text().split("STORAGE_VOLUME=$(docker compose config --format json 2>/dev/null | python3 -c '", 1)[1].split("' 2>/dev/null || true)", 1)[0]
    BASELINE_RESTORE = 'validate_docker_volume() {' + (BASELINE_ROOT / 'restore.sh').read_text().split('validate_docker_volume() {', 1)[1].split('# Resolve and validate the backup root', 1)[0]

class Baseline(unittest.TestCase):
    @unittest.skipUnless(BASELINE, 'explicit baseline comparison only')
    def test_external_name_is_not_project_prefixed(self):
        fragment = BASELINE_BACKUP
        config = {'name':'hc-fixture', 'services':{'backend':{'image':'fixture-image','volumes':[{'type':'volume','source':'storage_data','target':'/storage'}]}}, 'volumes':{'storage_data':{'name':'existing-external-storage','external':True}}}
        result = subprocess.run([sys.executable, '-c', fragment], input=json.dumps(config), capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), 'existing-external-storage')
    @unittest.skipUnless(BASELINE, 'explicit baseline comparison only')
    def test_bind_source_is_not_named_volume(self):
        fragment = BASELINE_BACKUP
        config = {'name':'hc-fixture', 'services':{'backend':{'image':'fixture-image','volumes':[{'type':'bind','source':'/isolated/fixture','target':'/storage'}]}}}
        result = subprocess.run([sys.executable, '-c', fragment], input=json.dumps(config), capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), '')
    @unittest.skipUnless(BASELINE, 'explicit baseline comparison only')
    def test_override_must_match_actual_backend(self):
        fragment = BASELINE_RESTORE
        script = 'log() { :; }; die() { exit 1; }; docker() { return 0; }; STORAGE_VOLUME=unrelated_existing; ' + fragment + '\nresolve_storage_volume\n'
        result = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)



@unittest.skipIf(BASELINE, 'green identity fixtures only')
class StorageFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.path = str(Path(self.tmp.name).resolve())
        self.cid = 'a' * 64
        self.hash = 'config-fixture-hash'
        self.config = {'name':'hc-fixture', 'services':{'backend':{'image':'fixture-image','volumes':[{'type':'volume','source':'storage_data','target':'/storage'}]}}, 'volumes':{'storage_data':{'name':'existing-external-storage','external':True}}}
        self.container = {'Id':self.cid,'Image':'sha256:' + 'c'*64,'Config':{'Labels':{'com.docker.compose.project':'hc-fixture','com.docker.compose.service':'backend','com.docker.compose.oneoff':'False','com.docker.compose.config-hash':self.hash}}, 'Mounts':[{'Type':'volume','Name':'existing-external-storage','Source':'/daemon/volumes/fixture/_data','Destination':'/storage','Driver':'local','RW':True}]}
        self.volume = {'Name':'existing-external-storage','Mountpoint':'/daemon/volumes/fixture/_data','Driver':'local','CreatedAt':'fixture-generation-1','Labels':{}}
        self.image = {'Id':'sha256:' + 'c'*64, 'Config':{'Volumes':None}}
        self.ids = self.cid
        self.calls = []
        self.env = patch.dict(os.environ, {'COMPOSE_PROJECT_NAME':'hc-fixture', 'STORAGE_PATH':'/storage','STORAGE_VOLUME':''})
        self.env.start()
        self.mock = patch.object(storage.subprocess, 'run', side_effect=self.fake)
        self.mock.start()
    def tearDown(self):
        self.mock.stop(); self.env.stop(); self.tmp.cleanup()
    def fake(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[0], 'docker')
        if args[1:5] == ['compose','--env-file','/dev/null','config']:
            result = json.dumps(self.config) if '--format' in args else 'backend ' + self.hash
        elif args[1:5] == ['compose','--env-file','/dev/null','ps']:
            result = self.ids
        elif args[1:3] == ['image','inspect']:
            result = json.dumps([self.image])
        elif args[1] == 'inspect':
            result = json.dumps([self.container])
        elif args[1:3] == ['volume','inspect']:
            result = json.dumps([self.volume])
        else:
            self.fail('unexpected Docker call: ' + str(args))
        return subprocess.CompletedProcess(args, 0, result, '')
    def bind(self, target='/storage'):
        self.config['services']['backend']['volumes'] = [{'type':'bind','source':self.path,'target':target}]
        self.container['Mounts'] = [{'Type':'bind','Source':self.path,'Destination':target,'RW':True}]
        os.environ['STORAGE_PATH'] = target
    def test_external_volume_name_and_read_only_archive(self):
        snapshot = storage.resolve_storage()
        self.assertEqual(snapshot['name'], 'existing-external-storage')
        args = storage.storage_command(snapshot,'ro','fixture-image',['tar','-czf','-','-C','/storage','.'])
        self.assertIn(self.cid + ':ro', args)
        self.assertNotIn('-v',args)
        self.assertNotIn('--mount',args)
    def test_backend_and_configured_image_identity_must_match(self):
        self.container['Image']='sha256:'+'d'*64
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_helper_image_is_pinned_local_and_has_no_implicit_volumes(self):
        snapshot=storage.resolve_storage()
        args=storage.storage_command(snapshot,'ro','fixture-image',['true'])
        self.assertIn('--pull=never',args)
        self.assertIn(self.image['Id'],args)
        self.assertNotIn('fixture-image',args)
        self.image['Config']['Volumes']={'/uncovered':{}}
        with self.assertRaises(storage.StorageError): storage.storage_command(snapshot,'ro','fixture-image',['true'])
        self.image['Config']['Volumes']={'/storage':{}}
        storage.storage_command(snapshot,'ro','fixture-image',['true'])
        self.image['Id']='not-an-image-id'
        with self.assertRaises(storage.StorageError): storage.storage_command(snapshot,'ro','fixture-image',['true'])
    def test_explicit_regular_named_volume(self):
        self.config['volumes']['storage_data'] = {'name':'hc-fixture_storage_data'}
        self.volume['Name'] = self.container['Mounts'][0]['Name'] = 'hc-fixture_storage_data'
        self.assertEqual(storage.resolve_storage()['name'],'hc-fixture_storage_data')
    def test_bind_uses_explicit_mount_and_selected_path(self):
        self.bind('/data/storage')
        snapshot = storage.resolve_storage()
        self.assertEqual(snapshot['type'],'bind')
        args=storage.storage_command(snapshot,'ro','fixture-image',['tar','-czf','-','-C','/data/storage','.'])
        self.assertIn('type=bind,src='+self.path+',dst=/data/storage,readonly',args)
        self.assertNotIn('-v',args)
    def test_restore_mount_is_explicit_writable(self):
        self.bind()
        args=storage.storage_command(storage.resolve_storage(),'rw','fixture-image',['sh','-c','true'],['--user','root','-i','--entrypoint','sh'])
        self.assertIn('type=bind,src='+self.path+',dst=/storage', args)
        self.assertNotIn('readonly', ' '.join(args))
    def test_override_cannot_select_unrelated_volume(self):
        os.environ['STORAGE_VOLUME']='unrelated-existing'
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_wrong_project_service_config_hash_and_oneoff(self):
        labels=self.container['Config']['Labels']
        for key,value in [('project','another'),('service','db'),('config-hash','stale'),('oneoff','True')]:
            with self.subTest(key=key):
                original=labels['com.docker.compose.'+key]
                labels['com.docker.compose.'+key]=value
                with self.assertRaises(storage.StorageError): storage.resolve_storage()
                labels['com.docker.compose.'+key]=original
    def test_missing_multiple_containers_and_mounts(self):
        for value in ('', self.cid+'\n'+'b'*64):
            self.ids=value
            with self.assertRaises(storage.StorageError): storage.resolve_storage()
        self.ids=self.cid
        for mounts in ([],self.container['Mounts']*2):
            self.container['Mounts']=mounts
            with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_type_source_and_volume_inspection_mismatch(self):
        mount=self.container['Mounts'][0]
        for key,value in [('Type','bind'),('Name','wrong'),('Source','/wrong'),('RW',False)]:
            original=mount[key]; mount[key]=value
            with self.assertRaises(storage.StorageError): storage.resolve_storage()
            mount[key]=original
        self.volume['Driver']='wrong'
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_anonymous_tmpfs_nested_and_missing_volume_rejected(self):
        declared=self.config['services']['backend']['volumes'][0]
        for key,value in [('source',''),('type','tmpfs'),('read_only',True)]:
            original=declared.get(key); declared[key]=value
            with self.assertRaises(storage.StorageError): storage.resolve_storage()
            if original is None: declared.pop(key)
            else: declared[key]=original
        self.config['services']['backend']['volumes'].append({'target':'/storage/nested','type':'volume','source':'extra'})
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_binding_must_exist_canonical_and_not_volume_override(self):
        self.bind()
        source=self.config['services']['backend']['volumes'][0]
        source['source']=self.container['Mounts'][0]['Source']=self.path+'/missing'
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
        self.bind(); os.environ['STORAGE_VOLUME']='unrelated'
        with self.assertRaises(storage.StorageError): storage.resolve_storage()
    def test_reinspection_rejects_changed_identity_before_helper(self):
        snapshot=storage.resolve_storage()
        for change in ('container','volume','mount'):
            saved=copy.deepcopy((self.container,self.volume))
            if change=='container': self.container['Id']='b'*64
            if change=='volume': self.volume['CreatedAt']='fixture-generation-2'
            if change=='mount': self.container['Mounts'][0]['Name']='different'
            with self.assertRaises(storage.StorageError): storage.storage_command(snapshot,'rw','fixture-image',['true'])
            self.container,self.volume=saved
        self.assertFalse(any(call[1]=='run' for call in self.calls))
    def test_bind_inode_replacement_fails_reinspection(self):
        self.bind(); snapshot=storage.resolve_storage()
        path=Path(self.path); path.rename(self.path+'-old'); path.mkdir()
        try:
            with self.assertRaises(storage.StorageError): storage.checked_storage(snapshot)
        finally:
            path.rmdir(); Path(self.path+'-old').rename(path)
    def test_bad_json_and_failed_inspect_fail_closed(self):
        self.mock.stop()
        for result in [subprocess.CompletedProcess([],1,'','failure'),subprocess.CompletedProcess([],0,'not-json','')]:
            with patch.object(storage.subprocess,'run',return_value=result):
                with self.assertRaises(storage.StorageError): storage.resolve_storage()
        self.mock.start()
    def test_no_unsafe_mount_path(self):
        for path in ('/','relative','/storage/../x','/storage,ro','/storage:ro','/storage//x'):
            os.environ['STORAGE_PATH']=path
            with self.assertRaises(storage.StorageError): storage.resolve_storage()

@unittest.skipIf(BASELINE, 'green reconciliation fixtures only')
class ReconciliationFixtures(unittest.TestCase):
    setUp = StorageFixtures.setUp
    tearDown = StorageFixtures.tearDown
    bind = StorageFixtures.bind
    def fake(self, args, **kwargs):
        if args[1] == 'run':
            self.calls.append(args)
            return subprocess.CompletedProcess(args, getattr(self,'run_status',0), getattr(self,'run_output',''), '')
        return StorageFixtures.fake(self, args, **kwargs)
    def test_reconcile_query_uses_selected_root_and_quotes_sql(self):
        query=reconcile.file_records_query({'target':'/data/storage'})
        self.assertIn("= '/data/storage/' ||",query)
        self.assertNotIn("= '/storage/' ||",query)
        self.assertIn("= '/data/o''bject/' ||",reconcile.file_records_query({'target':"/data/o'bject"}))
    def test_reconcile_named_volume_is_read_only(self):
        self.run_output='4 /storage/user/object\n'
        files=reconcile.list_storage_files(storage.resolve_storage(),'fixture-image')
        self.assertEqual(files,{'user/object':4})
        self.assertIn(self.cid+':ro',self.calls[-1])
    def test_reconcile_bind_uses_selected_path_and_read_only(self):
        self.bind('/data/files'); self.run_output='7 /data/files/user/item\n'
        files=reconcile.list_storage_files(storage.resolve_storage(),'fixture-image')
        self.assertEqual(files,{'user/item':7})
        self.assertIn('type=bind,src='+self.path+',dst=/data/files,readonly',self.calls[-1])
    def test_reconcile_enumeration_failure_is_not_empty_success(self):
        self.run_status=1
        with self.assertRaises(storage.StorageError): reconcile.list_storage_files(storage.resolve_storage(),'fixture-image')
    def test_reconcile_stat_has_valid_program_and_no_interpolation(self):
        self.run_output='9\n'; snapshot=storage.resolve_storage()
        self.assertEqual(reconcile.get_file_size(snapshot,'fixture-image',"user/o'bject"),9)
        args=self.calls[-1]; code=args[args.index('-c')+1]
        compile(code,'fixture-stat','exec')
        self.assertNotIn("o'bject",code)
        self.assertIn(self.cid+':ro',args)
    def test_reconcile_invalid_output_fails_closed(self):
        for output in ('not-size /storage/object\n','4 /other/object\n','unparseable\n'):
            self.run_output=output
            with self.assertRaises(storage.StorageError): reconcile.list_storage_files(storage.resolve_storage(),'fixture-image')

if __name__=='__main__': unittest.main()
