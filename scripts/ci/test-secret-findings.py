#!/usr/bin/env python3
"""Public-reference proof must not accept adjacent or unrelated credentials."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('secrets',Path(__file__).with_name('secret-findings.py'))
s=importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
SHA='a'*40
URL='https://go.googlesource.com/go/+/'+SHA


class Tests(unittest.TestCase):
    def finding(self,line,sha=SHA,rule='sourcegraph-access-token'):
        start=line.index(sha)
        return dict(RuleID=rule,Commit='b'*40,File='fixture.json',StartLine=1,EndLine=1,
                    StartColumn=start+2,EndColumn=start+42,Secret='REDACTED',Fingerprint='fixture')

    def check(self,line,verified=True,rule='sourcegraph-access-token',sha=SHA):
        return s.qualify([self.finding(line,sha,rule)],42,read_line=lambda finding:line,
                         verify_upstream=lambda url,sha:verified,verify_local=lambda sha,ancestor:verified,check_context=lambda *args:True)

    def test_exact_upstream_and_local_object(self):
        for line in ('  "url": "'+URL+'",','  "commit": "'+SHA+'",'):
            self.assertEqual(self.check(line)['status'],'PASS')
            self.assertEqual(self.check(line)['raw_findings'],1)
            self.assertEqual(self.check(line)['findings'][0]['classification'],'VERIFIED_PUBLIC_GIT_REFERENCE')
            self.assertEqual(self.check(line,verified=False)['status'],'BLOCKED')

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
        result=s.qualify([finding],42,read_line=lambda f:line,verify_upstream=lambda *args:True,check_context=lambda *args:True)
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
                         read_line=lambda f:'"commit":"'+SHA+'"',verify_local=lambda sha,ancestor:False,check_context=lambda *args:True)
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
                result=s.qualify([finding],42,read_line=lambda f:line,
                                 verify_local=lambda sha,ancestor:verified)
                self.assertEqual(result['status'],'PASS' if verified else 'BLOCKED')
                if verified:
                    self.assertEqual(result['findings'][0]['proof']['verification'],'EXACT_LOCAL_GIT_COMMIT_OBJECT')

    def test_column_types_rejected_before_arithmetic(self):
        line='"url":"'+URL+'"'
        for value in (None,'10',True,1.5):
            finding=self.finding(line)
            finding['StartColumn']=value
            with self.subTest(value=value),self.assertRaises(ValueError):
                s.candidate(finding,line)

    def test_gitiles_requires_exact_commit_json(self):
        response=MagicMock()
        response.__enter__.return_value=response
        opener=MagicMock()
        opener.open.return_value=response
        with patch.object(s.urllib.request,'build_opener',return_value=opener):
            response.read.return_value=b")]}'\n"+('{"commit":"'+SHA+'"}').encode()
            self.assertTrue(s.upstream(URL,SHA))
            response.read.return_value=b")]}'\n"+('{"commit":"'+'f'*40+'"}').encode()
            self.assertFalse(s.upstream(URL,SHA))
            response.read.return_value=b'{"commit":"'+SHA.encode()+b'"}'
            self.assertFalse(s.upstream(URL,SHA))


if __name__=='__main__':
    unittest.main()
