"""Targeted synthetic integrity, recovery measurements and admission boundary tests."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import admission
import harness
import recovery_model as model


class Integrity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root/'generation.json').write_text('{"generation":"g1"}')
        (self.root/'generation.json').chmod(0o600)
        self.rows = []
        for event_id in (1,2):
            data = model.payload(event_id)
            path = f'event-{event_id:04d}.bin'
            (self.root/path).write_bytes(data)
            (self.root/path).chmod(0o600)
            self.rows.append(dict(event_id=event_id,generation='g1',path=path,size=len(data),
                sha256=model.sha(data),owner_name='d513_owner',confirmed_ns=event_id*1000000000))

    def test_consistent_pair_has_exact_file_count_and_bytes(self):
        actual = model.validate_files(self.root,self.rows,'g1')
        self.assertEqual(actual['events'],2)
        self.assertEqual(actual['bytes'],sum(r['size'] for r in self.rows))

    def test_missing_corrupt_extra_or_generation_mismatch_rejected(self):
        for fault in ('missing','corrupt','extra','generation'):
            with self.subTest(fault=fault):
                path = self.root/self.rows[0]['path']
                original = path.read_bytes()
                if fault=='missing': path.unlink()
                elif fault=='corrupt': path.write_bytes(b'bad')
                elif fault=='extra': (self.root/'orphan.bin').write_bytes(b'extra')
                else: (self.root/'generation.json').write_text('{"generation":"g2"}')
                reason={'missing':'missing/linked','corrupt':'file bytes','extra':'unreferenced','generation':'generation mismatch'}[fault]
                with self.assertRaisesRegex(ValueError,reason): model.validate_files(self.root,self.rows,'g1')
                path.write_bytes(original)
                path.chmod(0o600)
                (self.root/'orphan.bin').unlink(missing_ok=True)
                (self.root/'generation.json').write_text('{"generation":"g1"}')

    def test_external_symlink_and_hardlink_not_followed(self):
        path = self.root/self.rows[0]['path']
        data = path.read_bytes()
        path.unlink()
        path.symlink_to(self.root/self.rows[1]['path'])
        with self.assertRaises(ValueError): model.validate_files(self.root,self.rows,'g1')
        with self.assertRaises(ValueError): model.inventory(self.root)
        path.unlink()
        os.link(self.root/self.rows[1]['path'],path)
        with self.assertRaises(ValueError): model.inventory(self.root)

    def test_dangling_reference_wrong_owner_duplicate_and_unsafe_path_rejected(self):
        for key,value in [('owner_name','other'),('path','../escape'),('generation','g2')]:
            rows=copy.deepcopy(self.rows);rows[0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError): model.validate_files(self.root,rows,'g1')
        with self.assertRaises(ValueError): model.validate_files(self.root,[self.rows[0]]*2,'g1')

    def test_corrupt_and_missing_backup_components_rejected_before_restore(self):
        full = dict(db={'PG_VERSION':{'sha256':'valid'}},hdd=model.inventory(self.root),logical={'dump':'valid'})
        model.verify_backup(full,full)
        for component in full:
            actual=copy.deepcopy(full);actual[component]={}
            with self.subTest(component=component),self.assertRaises(ValueError): model.verify_backup(actual,full)

    def test_inventory_binds_root_directory_owner_and_permissions(self):
        before=model.inventory(self.root)
        self.root.chmod(0o755)
        self.assertNotEqual(before,model.inventory(self.root))
        with self.assertRaises(ValueError): model.validate_files(self.root,self.rows,'g1')
        self.root.chmod(0o700)

    def test_metrics_separate_lost_confirmed_events_bytes_and_rto(self):
        actual=model.measurements(self.rows,self.rows[:1],3*10**9,7*10**9,0)
        self.assertEqual(actual['rpo_seconds'],1)
        self.assertEqual(actual['rto_seconds'],4)
        self.assertEqual(actual['lost_events'],1)
        self.assertEqual(actual['lost_bytes'],self.rows[1]['size'])
        zero=model.measurements(self.rows,self.rows,3*10**9,3*10**9,0)
        self.assertEqual(zero['rpo_seconds'],0)
        self.assertEqual(zero['lost_events'],0)

    def test_metrics_reject_holes_mutated_events_and_invalid_clock(self):
        rows=self.rows+[dict(self.rows[-1],event_id=3,confirmed_ns=3*10**9)]
        with self.assertRaisesRegex(ValueError,'holes'): model.measurements(rows,[rows[0],rows[2]],4*10**9,5*10**9,0)
        with self.assertRaisesRegex(ValueError,'identity changed'): model.measurements(rows,[dict(rows[0],size=1)],4*10**9,5*10**9,0)
        with self.assertRaises(ValueError): model.measurements(rows,rows,2,1,0)
        with self.assertRaisesRegex(ValueError,'after failure'): model.measurements(rows,rows,1,2,0)


class AdmissionBoundaries(unittest.TestCase):
    def test_absent_db_or_hdd_backup_stops_before_root_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()
            for name in ['db','hdd','logical']:
                (root/name).mkdir()
            for missing in ['db','hdd']:
                (root/missing).rmdir()
                obj=harness.Drill.__new__(harness.Drill)
                obj.runner=Mock()
                with self.assertRaisesRegex(ValueError,'missing or linked backup component'):
                    obj.backup_inventory(root)
                obj.runner.assert_not_called()
                (root/missing).mkdir()

    def test_temporary_bootstrap_server_cannot_satisfy_final_readiness(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp);fixture=Mock();fixture.ledger={}
            config='sha256:'+'a'*64
            inspect=json.dumps([dict(Image=config,State=dict(Running=True))]).encode()
            runner=Mock(side_effect=lambda argv,**kw: SimpleNamespace(stdout=(b'PASS: HomeCloud startup disk gate' if argv[1]=='logs' else inspect),stderr=b'',returncode=0))
            comm=iter([b'bash\n',b'postgres\n'])
            cmd=iter([b'/bin/bash\0docker-entrypoint.sh\0postgres\0',b'postgres\0'])
            def execute(container,*argv,**kw):
                value=next(comm) if argv==('cat','/proc/1/comm') else next(cmd) if argv==('cat','/proc/1/cmdline') else b'Uid:\t70\t70\t70\t70\n'
                return SimpleNamespace(stdout=value,stderr=b'',returncode=0)
            fixture.exec.side_effect=execute
            drill=harness.Drill(out,runner,fixture,{})
            drill.sql=Mock(return_value='16.15|f')
            with patch.object(harness.time,'sleep') as sleep:
                drill.ready('synthetic',config)
                sleep.assert_called_once()
            self.assertEqual(sum(call.args[1]=='pg_isready' for call in fixture.exec.call_args_list),1)
            drill.sql.assert_called_once()

    def test_failed_gate_never_loads_image_or_constructs_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp); runner=Mock();factory=Mock()
            reject=Mock(side_effect=ValueError('existing mandatory gate BLOCKED'))
            with self.assertRaises(ValueError): harness.execute(out,out,runner,admit=reject,factory=factory)
            runner.assert_not_called();factory.assert_not_called()
            status=json.loads((out/'harness-status.json').read_text())
            self.assertFalse(status['runtime_started'])
            self.assertEqual(status['drill'],'NOT_RUN')
            self.assertEqual(status['status'],'BLOCKED_BEFORE_RUNTIME')
            self.assertIsNone(status['rpo'])

    def test_cleanup_on_partial_setup_failure_is_not_reported_as_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp);fixture=Mock();fixture.ledger={'cleanup':'PASS'}
            fixture.create.side_effect=ValueError('hosted fixture unsupported')
            with patch.dict(os.environ,RUNNER_TEMP=temp,GITHUB_RUN_ID='1'):
                with patch.object(harness,'load_images'):
                    with self.assertRaises(ValueError):
                        harness.execute(out,out,Mock(),admit=lambda *a: ({},{}),factory=lambda *a:fixture)
            fixture.cleanup.assert_called_once()
            status=json.loads((out/'harness-status.json').read_text())
            self.assertEqual(status['status'],'FAILED')
            self.assertFalse(status['complete'])

    def test_source_run_attempt_and_job_cannot_reuse_other_runner_pass(self):
        env=dict(GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='1',GITHUB_JOB='job',GITHUB_SHA='a'*40)
        context=dict(source='b'*40,run_id='1')
        evidence=dict(source_commit='b'*40,github=dict(run_id='1',run_attempt='1',job='job',sha='a'*40,runner_environment='github-hosted'))
        admission.validate_scope(context,evidence,env,'b'*40)
        for key in env:
            bad=dict(env,**{key:'changed'})
            with self.subTest(key=key),self.assertRaises(ValueError): admission.validate_scope(context,evidence,bad,'b'*40)


if __name__=='__main__':
    unittest.main()
