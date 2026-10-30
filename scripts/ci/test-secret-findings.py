#!/usr/bin/env python3
"""Public-reference proof must not accept adjacent or unrelated credentials."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('secrets',Path(__file__).with_name('secret-findings.py'))
s=importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
SHA='a'*40
URL='https://go.googlesource.com/go/+/'+SHA
REPORT_SHA='d'*64


class Tests(unittest.TestCase):
    def finding(self,line,sha=SHA,rule='sourcegraph-access-token'):
        start=line.index(sha)
        return dict(RuleID=rule,Commit='b'*40,File='fixture.json',StartLine=1,EndLine=1,
                    StartColumn=start+2,EndColumn=start+42,Secret='REDACTED',Fingerprint='fixture')

    def check(self,line,verified=True,rule='sourcegraph-access-token',sha=SHA):
        return s.qualify([self.finding(line,sha,rule)],42,raw_report_sha256=REPORT_SHA,read_line=lambda finding:line,
                         verify_upstream=lambda url,sha:verified,verify_local=lambda sha,ancestor:verified,check_context=lambda *args:True)

    def test_exact_upstream_and_local_object(self):
        upstream_line='  "url": "'+URL+'",'
        result=self.check(upstream_line)
        self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['raw_findings'],1)
        self.assertEqual(result['findings'][0]['classification'],'VERIFIED_PUBLIC_GIT_REFERENCE')
        self.assertEqual(self.check(upstream_line,verified=False)['status'],'BLOCKED')

        local_line='  "commit": "'+SHA+'",'
        finding=self.finding(local_line)
        with patch.object(s,'upstream') as verify_upstream, patch.object(s,'local_commit',return_value=True) as verify_local:
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:local_line,verify_local=s.local_commit,
                             verify_upstream=s.upstream,check_context=lambda *_:True)
        self.assertEqual(result['status'],'PASS')
        verify_local.assert_called_once_with(SHA,'b'*40)
        verify_upstream.assert_not_called()

    def test_spoofed_host_path_key_and_adjacent_token_block(self):
        for line in ('"url":"https://go.googlesource.com.evil/go/+/'+SHA+'"',
                     '"url":"https://go.googlesource.com/go/+/'+SHA+'?token=x"',
                     '"url":"https://go.googlesource.com/unknown/+/'+SHA+'"',
                     '"url":"http://go.googlesource.com/go/+/'+SHA+'"',
                     '"token":"'+SHA+'"',
                     '"url":"'+URL+'", "token":"'+'c'*40+'"',
                     '"commit":"'+SHA+'", "token":"'+'c'*40+'"'):
            self.assertEqual(self.check(line)['status'],'BLOCKED')
        adjacent='"url":"'+URL+'", "token":"'+'c'*40+'"'
        self.assertEqual(self.check(adjacent,sha='c'*40)['status'],'BLOCKED')

    def test_other_rule_and_coordinate_mismatch_stay_blocked(self):
        line='"url":"'+URL+'"'
        self.assertEqual(self.check(line,rule='github-pat')['status'],'BLOCKED')
        finding=self.finding(line)
        finding['StartColumn']+=1
        result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,verify_upstream=lambda *args:True,check_context=lambda *args:True)
        self.assertEqual(result['status'],'BLOCKED')

    def test_infrastructure_and_malformed_report_fail_closed(self):
        for findings,code in (([],1),([],42),([{}],42),({},0),([dict(Secret='raw')],42)):
            with self.subTest(findings=findings,code=code),self.assertRaises(ValueError):
                s.qualify(findings,code)
        self.assertEqual(s.qualify([],0)['status'],'PASS')

    def test_forbidden_source_never_read(self):
        finding=self.finding('"commit":"'+SHA+'"')
        finding['File']=s.FORBIDDEN
        with self.assertRaises(ValueError):
            s.source_line(finding)

    def test_unknown_local_sha_does_not_pass_as_metadata(self):
        result=s.qualify([self.finding('"commit":"'+SHA+'"')],42,
                         raw_report_sha256=REPORT_SHA,read_line=lambda f:'"commit":"'+SHA+'"',verify_local=lambda sha,ancestor:False,check_context=lambda *args:True)
        self.assertEqual(result['status'],'BLOCKED')

    def test_arbitrary_source_context_is_never_qualified(self):
        finding=self.finding('"commit":"'+SHA+'"')
        with self.assertRaises(ValueError):
            s.historical_context(finding,('local_git_commit',None,SHA,'b'*40))

    def test_local_commit_must_be_ancestor_of_finding_history(self):
        with patch.object(s,'git',return_value='commit'),patch.object(s.subprocess,'run') as run:
            run.return_value.returncode=1
            self.assertFalse(s.local_commit(SHA,'b'*40))
            run.return_value.returncode=0
            self.assertTrue(s.local_commit(SHA,'b'*40))
            self.assertEqual(run.call_args.args[0],['git','merge-base','--is-ancestor',SHA,'b'*40])

    def test_old_url_false_flag_requires_independent_local_object_proof(self):
        record=dict(rule='sourcegraph-access-token',file=s.GO_EVIDENCE,line=1,
                    commit=SHA,public_go_commit_reference_verified=False)
        blob=json.dumps(dict(status='BLOCKED_NO_EXCEPTION',scanner='gitleaks 8.30.1',
                             findings_count=1,findings=[record]),indent=2)
        line_number=next(index+1 for index,line in enumerate(blob.splitlines()) if '"commit"' in line)
        line=blob.splitlines()[line_number-1]
        finding=self.finding(line)
        finding.update(File=s.METADATA_EVIDENCE,StartLine=line_number,EndLine=line_number)
        def historical(commit,path):
            return blob if path==s.METADATA_EVIDENCE else '"url":"'+URL+'"'
        with patch.object(s,'historical_blob',side_effect=historical):
            for verified in (False,True):
                result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,
                                 verify_local=lambda sha,ancestor:verified)
                self.assertEqual(result['status'],'PASS' if verified else 'BLOCKED')
                if verified:
                    proof=result['findings'][0]['proof']
                    self.assertEqual(proof['verification'],'EXACT_LOCAL_GIT_COMMIT_OBJECT')
                    self.assertEqual(proof['raw_report_sha256'],REPORT_SHA)
                    self.assertEqual(proof['finding_fingerprint'],finding['Fingerprint'])
                    self.assertEqual(proof['source_line'],line)
                    self.assertEqual(proof['source_file'],finding['File'])
                    self.assertEqual(proof['source_line_number'],finding['StartLine'])
                    self.assertEqual(proof['source_columns'],[finding['StartColumn'],finding['EndColumn']])
                    self.assertEqual(proof['source_line_sha256'],hashlib.sha256(line.encode()).hexdigest())

    def test_column_types_rejected_before_arithmetic(self):
        line='"url":"'+URL+'"'
        for value in (None,'10',True,1.5):
            finding=self.finding(line)
            finding['StartColumn']=value
            with self.subTest(value=value),self.assertRaises(ValueError):
                s.candidate(finding,line)

    def synthetic_commit(self,body=b'local test commit'):
        payload=(b'tree '+b'0'*40+b'\nparent '+b'1'*40+b'\n'
                 b'author Test <test@example.invalid> 0 +0000\n'
                 b'committer Test <test@example.invalid> 0 +0000\n\n'+body+b'\n')
        oid=hashlib.sha1(b'commit '+str(len(payload)).encode()+b'\0'+payload).hexdigest()
        return payload,oid

    def git_run_stub(self,payload,fetch_status=0,fetch_stderr=b''):
        calls=[]
        fetches=0
        def run(command,**kwargs):
            nonlocal fetches
            calls.append((command,kwargs))
            if 'fetch' in command:
                status=(fetch_status[min(fetches,len(fetch_status)-1)]
                        if isinstance(fetch_status,tuple) else fetch_status)
                fetches+=1
                return SimpleNamespace(returncode=status,stdout=b'',stderr=fetch_stderr)
            if command[-3:-1]==['cat-file','-t']:
                return SimpleNamespace(returncode=0,stdout=b'commit\n',stderr=b'')
            if command[-3:-1]==['cat-file','commit']:
                return SimpleNamespace(returncode=0,stdout=payload,stderr=b'')
            return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
        return calls,run

    def test_upstream_fetch_success_binds_report_fingerprint_and_source_line(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='  "url": "'+url+'",'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:line,check_context=lambda *_:True)
        self.assertEqual(result['status'],'PASS')
        proof=result['findings'][0]['proof']
        self.assertEqual(proof['raw_report_sha256'],REPORT_SHA)
        self.assertEqual(proof['finding_fingerprint'],finding['Fingerprint'])
        self.assertEqual(proof['source_line'],line)
        self.assertEqual(proof['source_line_sha256'],hashlib.sha256(line.encode()).hexdigest())
        self.assertEqual(proof['source_columns'],[finding['StartColumn'],finding['EndColumn']])
        self.assertEqual(proof['object_id'],sha)
        fetch,kwargs=next((command,kwargs) for command,kwargs in calls if 'fetch' in command)
        self.assertEqual(fetch[-2:],[s.UPSTREAM_GO_REPOSITORY,sha])
        self.assertIn('http.sslVerify=true',fetch)
        self.assertIn('http.followRedirects=false',fetch)
        self.assertEqual(kwargs['env']['GIT_CONFIG_NOSYSTEM'],'1')
        self.assertEqual(kwargs['env']['GIT_CONFIG_GLOBAL'],os.devnull)
        self.assertEqual(kwargs['env']['GIT_TERMINAL_PROMPT'],'0')
        for key in ('GIT_SSL_NO_VERIFY','GIT_CONFIG_COUNT','GIT_DIR','GIT_WORK_TREE'):
            self.assertNotIn(key,kwargs['env'])

    def test_unlisted_canonical_go_and_net_objects_are_verified_by_exact_oid(self):
        payload,sha=self.synthetic_commit(b'previously unlisted canonical object')
        for project in ('go','net'):
            url=f'https://go.googlesource.com/{project}/+/{sha}'
            calls,run=self.git_run_stub(payload)
            with patch.object(s.subprocess,'run',side_effect=run):
                self.assertTrue(s.upstream(url,sha))
            fetch,kwargs=next((command,kwargs) for command,kwargs in calls if 'fetch' in command)
            self.assertEqual(fetch[-2:],[f'https://go.googlesource.com/{project}',sha])
            self.assertIn('http.sslVerify=true',fetch)
            self.assertIn('http.followRedirects=false',fetch)

    def test_noncanonical_upstream_locations_never_start_network(self):
        unknown='f'*40
        with patch.object(s.subprocess,'run') as run:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/g'+unknown[1:],unknown))
            self.assertFalse(s.upstream('https://go.googlesource.com.evil/go/+/'+unknown,unknown))
            self.assertFalse(s.upstream('https://go.googlesource.com/other/+/'+unknown,unknown))
            self.assertFalse(s.upstream('http://go.googlesource.com/go/+/'+unknown,unknown))
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+unknown,'x'*40))
            run.assert_not_called()

    def test_upstream_object_substitution_stays_blocked(self):
        _,sha=self.synthetic_commit()
        wrong_payload,_=self.synthetic_commit(b'substituted object')
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        calls,run=self.git_run_stub(wrong_payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            self.assertFalse(s.upstream(url,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),1)

    def test_upstream_network_failure_stays_blocked_after_bounded_retry(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload,fetch_status=1)
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.time,'sleep'):
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:line,check_context=lambda *_:True)
        self.assertEqual(result['status'],'BLOCKED')
        self.assertEqual(result['unresolved_findings'],1)
        self.assertEqual(sum('fetch' in command for command,_ in calls),3)

    def test_transient_fetch_retries_only_the_same_exact_object(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        calls,run=self.git_run_stub(payload,fetch_status=(1,0))
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.time,'sleep'):
            self.assertTrue(s.upstream(url,sha))
        fetches=[command for command,_ in calls if 'fetch' in command]
        self.assertEqual(len(fetches),2)
        self.assertEqual(fetches[0],fetches[1])
        self.assertEqual(fetches[0][-2:],[s.UPSTREAM_GO_REPOSITORY,sha])

    def test_transient_timeout_retries_without_exposing_git_stderr(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload)
        failed=[False]
        def timeout_once(command,**kwargs):
            if 'fetch' in command and not failed[0]:
                failed[0]=True
                raise s.subprocess.TimeoutExpired(command,60)
            return run(command,**kwargs)
        with patch.object(s.subprocess,'run',side_effect=timeout_once),patch.object(s.time,'sleep') as sleep:
            self.assertTrue(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        sleep.assert_called_once_with(1)

    def test_missing_object_fails_without_retry_and_logs_only_category(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload,fetch_status=128,
                                    fetch_stderr=b'fatal: remote error: upload-pack: not our ref private-secret-value')
        output=io.StringIO()
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.sys,'stderr',output), \
                patch.object(s.time,'sleep') as sleep:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),1)
        sleep.assert_not_called()
        self.assertIn('OBJECT_UNAVAILABLE',output.getvalue())
        self.assertNotIn('private-secret-value',output.getvalue())

    def test_rate_limit_retries_same_sha_then_blocks(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload,fetch_status=429,fetch_stderr=b'HTTP 429')
        output=io.StringIO()
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.sys,'stderr',output), \
                patch.object(s.time,'sleep') as sleep:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list],[1,3])
        self.assertIn('RATE_LIMITED',output.getvalue())

    def test_upstream_without_raw_report_digest_stays_blocked(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            with self.assertRaises(ValueError):
                s.qualify([finding],42,read_line=lambda _:line,check_context=lambda *_:True)
        self.assertFalse(any('fetch' in command for command,_ in calls))

    def test_invalid_or_missing_fingerprint_and_digest_fail_closed(self):
        line='"url":"'+URL+'"'
        finding=self.finding(line)
        finding['Fingerprint']=''
        with self.assertRaises(ValueError):
            s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda _:line)
        finding=self.finding(line)
        with self.assertRaises(ValueError):
            s.qualify([finding],42,read_line=lambda _:line,check_context=lambda *_:True)
        with self.assertRaises(ValueError):
            s.qualify([finding],42,raw_report_sha256='xyz',read_line=lambda _:line)

    def test_unqualified_context_and_real_credentials_never_request_upstream(self):
        lines=('"url":"'+URL+'"','"token":"'+SHA+'"',
               '"url":"'+URL+'", "token":"'+'c'*40+'"')
        with patch.object(s.subprocess,'run') as run:
            for line in lines:
                result=s.qualify([self.finding(line)],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,check_context=lambda *args:False)
                self.assertEqual(result['status'],'BLOCKED')
            real_secret=self.finding(lines[0],rule='github-pat')
            self.assertEqual(s.qualify([real_secret],42,raw_report_sha256=REPORT_SHA)['status'],'BLOCKED')
            run.assert_not_called()


if __name__=='__main__':
    unittest.main()
