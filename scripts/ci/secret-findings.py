#!/usr/bin/env python3
"""Classify exact public Git references in retained redacted gitleaks findings.

All scanner findings remain in the raw report. This does not exempt paths, rules,
unknown 40-hex strings, unavailable references, or neighbouring credentials.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
from functools import lru_cache
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile

SHA = re.compile(r'[a-f0-9]{40}')
GO_LINE = re.compile(r'\s*"url"\s*:\s*"(https://go\.googlesource\.com/(?:go|net)/\+/([a-f0-9]{40}))"\s*,?\s*')
COMMIT_LINE = re.compile(r'\s*"commit"\s*:\s*"([a-f0-9]{40})"\s*,?\s*')
GO_EVIDENCE = 'docs/evidence/d5-1-5-20261014/pg-govulncheck.json'
METADATA_EVIDENCE = 'docs/evidence/d5-1-5-policy-secret-findings-20261015.json'
FORBIDDEN = 'scripts/tests/' + 'PHASE-5.3.1-TEST-AUDIT.md'
UPSTREAM_GO_REPOSITORY = 'https://go.googlesource.com/go'
UPSTREAM_GO_REPOSITORIES = {
    'go': UPSTREAM_GO_REPOSITORY,
    'net': 'https://go.googlesource.com/net',
}


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode('utf-8')


@lru_cache(maxsize=8)
def historical_blob(commit,path):
    if path not in (GO_EVIDENCE,METADATA_EVIDENCE):
        raise ValueError('Unqualified reference source context')
    return git('show',commit+':'+path)


def source_line(finding):
    commit, path = finding['Commit'], finding['File']
    if not isinstance(commit, str) or not SHA.fullmatch(commit):
        raise ValueError('Invalid finding source commit')
    if (not isinstance(path, str) or str(PurePosixPath(path)) != path or path.startswith('/')
            or '..' in PurePosixPath(path).parts or path == FORBIDDEN):
        raise ValueError('Invalid or excluded finding source path')
    if finding['StartLine'] != finding['EndLine'] or type(finding['StartLine']) is not int or finding['StartLine'] < 1:
        raise ValueError('Expected a single source line')
    lines = historical_blob(commit,path).splitlines()
    if finding['StartLine'] > len(lines):
        raise ValueError('Finding source line missing')
    return lines[finding['StartLine']-1]


def candidate(finding, line):
    if finding.get('RuleID') != 'sourcegraph-access-token':
        return None
    # Pinned gitleaks git reports include the leading '+' diff marker in columns.
    # Stored Git blob lines have no diff marker; remove exactly that one column.
    if type(finding['StartColumn']) is not int or type(finding['EndColumn']) is not int:
        raise ValueError('Invalid finding source columns')
    start, end = finding['StartColumn']-1, finding['EndColumn']-1
    if not 1 <= start <= end <= len(line):
        raise ValueError('Invalid finding source columns')
    span = line[start-1:end]
    # Pinned legacy rule includes the delimiter after the 40-hex match.
    found = re.fullmatch(r'([a-f0-9]{40})(?:[^a-f0-9])?', span)
    if not found:
        return None
    match = GO_LINE.fullmatch(line)
    if match and found[1] == match[2] and start-1 == match.start(2):
        return ('upstream_go_commit', match[1], match[2], None)
    match = COMMIT_LINE.fullmatch(line)
    if match and found[1] == match[1] and start-1 == match.start(1):
        return ('local_git_commit', None, match[1], finding['Commit'])
    return None


def historical_context(finding,plan):
    blob=historical_blob(finding['Commit'],finding['File'])
    if plan[0]=='upstream_go_commit':
        if finding['File'] != GO_EVIDENCE:
            return False
        decoder=json.JSONDecoder()
        remaining=blob
        messages=[]
        while remaining.strip():
            remaining=remaining.lstrip()
            message,end=decoder.raw_decode(remaining)
            messages.append(message)
            remaining=remaining[end:]
        return (messages[0].get('config',{}).get('scanner_name')=='govulncheck'
                and messages[0]['config'].get('scan_mode')=='binary'
                and any(ref.get('type')=='FIX' and ref.get('url')==plan[1]
                        for message in messages for ref in message.get('osv',{}).get('references',[])))
    if finding['File'] != METADATA_EVIDENCE:
        return False
    document=json.loads(blob)
    if (document.get('scanner')!='gitleaks 8.30.1' or document.get('status')!='BLOCKED_NO_EXCEPTION'
            or document.get('findings_count')!=len(document.get('findings',[]))):
        return False
    lines=blob.splitlines()
    index=finding['StartLine']-1
    # This fixed evidence schema records one finding object in seven JSON lines.
    record=json.loads('\n'.join(lines[index-4:index+3]).strip().rstrip(','))
    if (record not in document['findings'] or record.get('rule')!='sourcegraph-access-token'
            or record.get('file')!=GO_EVIDENCE or record.get('commit')!=plan[2]
            or type(record.get('public_go_commit_reference_verified')) is not bool):
        return False
    original=historical_blob(plan[2],GO_EVIDENCE).splitlines()
    line=record.get('line')
    return type(line) is int and 0 < line <= len(original) and bool(GO_LINE.fullmatch(original[line-1]))


def upstream(url, sha):
    # Fetch only an exact commit reference from a canonical Go project over
    # verified HTTPS. The temporary bare repository is discarded; no local
    # object cache can pass.
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        return False
    upstream_repository = next((repo for repo in UPSTREAM_GO_REPOSITORIES.values()
                                if url == repo+'/+/'+sha), None)
    if upstream_repository is None:
        return False
    env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_TERMINAL_PROMPT='0')
    try:
        with tempfile.TemporaryDirectory(prefix='homecloud-go-object-') as temp:
            repository=os.path.join(temp,'objects.git')
            commands=(
                ['git','init','--bare','--quiet',repository],
                ['git','-C',repository,'-c','http.sslVerify=true','-c','http.followRedirects=false',
                 '-c','credential.helper=','fetch','--no-tags','--depth=1',upstream_repository,sha],
                ['git','-C',repository,'cat-file','-t',sha],
            )
            for index,command in enumerate(commands):
                # Retry only the same exact-object fetch once on a transient failure.
                # Both attempts still require the commit type and object ID proof below.
                result=None
                for attempt in range(2 if index == 1 else 1):
                    try:
                        result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                              env=env,timeout=60,check=False)
                    except subprocess.TimeoutExpired:
                        if attempt == 0 and index == 1:
                            continue
                        return False
                    if result.returncode == 0:
                        break
                if result is None or result.returncode != 0:
                    return False
                if index == 2 and result.stdout.strip() != b'commit':
                    return False
            result=subprocess.run(['git','-C',repository,'cat-file','commit',sha],
                                  stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                  env=env,timeout=60,check=False)
            if result.returncode != 0:
                return False
            payload=result.stdout
            object_header=b'commit '+str(len(payload)).encode('ascii')+b'\0'
            actual=hashlib.sha1(object_header+payload).hexdigest()
            return actual == sha
    except (OSError,subprocess.SubprocessError,TimeoutError):
        return False


def local_commit(sha,ancestor):
    try:
        return (git('cat-file','-t',sha).strip() == 'commit'
                and subprocess.run(['git','merge-base','--is-ancestor',sha,ancestor],
                                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0)
    except subprocess.SubprocessError:
        return False


def qualify(findings, scanner_exit, raw_report_sha256=None, read_line=source_line, verify_upstream=upstream, verify_local=local_commit, check_context=historical_context):
    if scanner_exit not in (0,42) or not isinstance(findings,list) or (scanner_exit == 0) != (len(findings) == 0):
        raise ValueError('Scanner failure or inconsistent report')
    if findings and (not isinstance(raw_report_sha256,str)
                     or not re.fullmatch(r'[a-f0-9]{64}',raw_report_sha256)):
        raise ValueError('Missing or invalid raw report digest')
    plans = []
    for finding in findings:
        if (not isinstance(finding,dict) or finding.get('Secret') != 'REDACTED'
                or not isinstance(finding.get('Fingerprint'),str) or not finding['Fingerprint']):
            raise ValueError('Expected complete redacted scanner finding')
        plan = None
        line = None
        if finding.get('RuleID') == 'sourcegraph-access-token':
            line = read_line(finding)
            plan = candidate(finding,line)
            if plan and not check_context(finding,plan):
                plan = None
        plans.append((plan,line))
    checks = sorted(set((plan for plan,line in plans if plan)),
                    key=lambda item:(item[0],item[1] or '',item[2],item[3] or ''))
    def verify(plan):
        kind,url,sha,ancestor = plan
        valid=(raw_report_sha256 is not None) if kind == 'upstream_go_commit' else True
        return plan, valid and (verify_upstream(url,sha) if kind == 'upstream_go_commit' else verify_local(sha,ancestor))
    with ThreadPoolExecutor(max_workers=8) as pool:
        verified = dict(pool.map(verify,checks))
    records = []
    for finding,(plan,line) in zip(findings,plans):
        accepted = bool(plan and verified.get(plan))
        record = dict(fingerprint=finding['Fingerprint'],rule=finding['RuleID'],file=finding['File'],
                      line=finding['StartLine'],columns=[finding['StartColumn'],finding['EndColumn']],
                      classification='VERIFIED_PUBLIC_GIT_REFERENCE' if accepted else 'BLOCKED_UNCLASSIFIED_FINDING',
                      reason=('EXACT_REFERENCE_AND_OBJECT_VERIFIED' if accepted else
                              ('REFERENCE_OBJECT_UNAVAILABLE_OR_UNVERIFIED' if plan else 'UNQUALIFIED_RULE_SOURCE_OR_SPAN')))
        if accepted:
            record['proof'] = dict(kind=plan[0],
                                   verification='HTTPS_GIT_COMMIT_OBJECT_ID_MATCH' if plan[0]=='upstream_go_commit' else 'EXACT_LOCAL_GIT_COMMIT_OBJECT',
                                   source_commit=finding['Commit'],raw_report_sha256=raw_report_sha256,
                                   finding_fingerprint=finding['Fingerprint'],source_file=finding['File'],
                                   source_line_number=finding['StartLine'],source_line=line,
                                   source_columns=[finding['StartColumn'],finding['EndColumn']],
                                   source_line_sha256=hashlib.sha256(line.encode()).hexdigest())
            if plan[0]=='upstream_go_commit':
                record['proof'].update(object_id=plan[2],url=plan[1],
                                       transport='HTTPS; certificate verification enabled; redirects disabled')
        records.append(record)
    blocked=sum(record['classification'] != 'VERIFIED_PUBLIC_GIT_REFERENCE' for record in records)
    return dict(format='homecloud-secret-reference-evidence-v1',scanner_exit=scanner_exit,
                raw_findings=len(findings),verified_public_references=len(findings)-blocked,
                unresolved_findings=blocked,findings=records,status='BLOCKED' if blocked else 'PASS')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',required=True)
    parser.add_argument('--scanner-exit',required=True,type=int)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        raw=Path(args.report).read_bytes()
        report_sha256=hashlib.sha256(raw).hexdigest()
        result=qualify(json.loads(raw),args.scanner_exit,raw_report_sha256=report_sha256)
        result['raw_report_sha256']=report_sha256
    except (OSError,ValueError,KeyError,TypeError,UnicodeError,subprocess.SubprocessError):
        result=dict(format='homecloud-secret-reference-evidence-v1',status='BLOCKED',error='Invalid or unavailable scanner/reference evidence')
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key != 'findings'},sort_keys=True))
    return 0 if result['status']=='PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
