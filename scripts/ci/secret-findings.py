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
from pathlib import Path, PurePosixPath
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

SHA = re.compile(r'[a-f0-9]{40}')
GO_LINE = re.compile(r'\s*"url"\s*:\s*"(https://go\.googlesource\.com/(?:go|net)/\+/([a-f0-9]{40}))"\s*,?\s*')
COMMIT_LINE = re.compile(r'\s*"commit"\s*:\s*"([a-f0-9]{40})"\s*,?\s*')
GO_EVIDENCE = 'docs/evidence/d5-1-5-20261014/pg-govulncheck.json'
METADATA_EVIDENCE = 'docs/evidence/d5-1-5-policy-secret-findings-20261015.json'
FORBIDDEN = 'scripts/tests/' + 'PHASE-5.3.1-TEST-AUDIT.md'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


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
    # Fixed Gitiles host/project/path, no redirects or credential headers.
    if not isinstance(sha,str) or not SHA.fullmatch(sha) or not re.fullmatch(r'https://go\.googlesource\.com/(?:go|net)/\+/'+sha, url):
        return False
    request = urllib.request.Request(url+'?format=JSON', headers={'Accept':'application/json'})
    opener = urllib.request.build_opener(NoRedirect())
    # qualify deduplicates upstream plans. Each unique reference gets at most
    # two requests; only transport failures and transient HTTP failures retry.
    for attempt in range(2):
        try:
            with opener.open(request, timeout=15) as response:
                payload = response.read(1024*1024+1)
        except urllib.error.HTTPError as error:
            transient = error.code in (408,429,500,502,503,504)
            error.close()
            if attempt == 0 and transient:
                continue
            return False
        except urllib.error.URLError as error:
            if attempt == 0 and not isinstance(error.reason,ssl.SSLError):
                continue
            return False
        except ssl.SSLError:
            return False
        except OSError:
            if attempt == 0:
                continue
            return False
        # A received response must itself prove the exact object. Malformed,
        # oversized or mismatched content never earns another request.
        if len(payload) > 1024*1024 or not payload.startswith(b")]}'\n"):
            return False
        try:
            document = json.loads(payload[5:])
        except (ValueError,UnicodeError):
            return False
        return isinstance(document,dict) and document.get('commit') == sha
    return False


def local_commit(sha,ancestor):
    try:
        return (git('cat-file','-t',sha).strip() == 'commit'
                and subprocess.run(['git','merge-base','--is-ancestor',sha,ancestor],
                                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0)
    except subprocess.SubprocessError:
        return False


def qualify(findings, scanner_exit, read_line=source_line, verify_upstream=upstream, verify_local=local_commit, check_context=historical_context):
    if scanner_exit not in (0,42) or not isinstance(findings,list) or (scanner_exit == 0) != (len(findings) == 0):
        raise ValueError('Scanner failure or inconsistent report')
    plans = []
    for finding in findings:
        if not isinstance(finding,dict) or finding.get('Secret') != 'REDACTED' or not isinstance(finding.get('Fingerprint'),str):
            raise ValueError('Expected complete redacted scanner finding')
        plan = None
        if finding.get('RuleID') == 'sourcegraph-access-token':
            plan = candidate(finding,read_line(finding))
            if plan and not check_context(finding,plan):
                plan = None
        plans.append(plan)
    checks = set(plan for plan in plans if plan)
    def verify(plan):
        kind,url,sha,ancestor = plan
        return plan, verify_upstream(url,sha) if kind == 'upstream_go_commit' else verify_local(sha,ancestor)
    with ThreadPoolExecutor(max_workers=8) as pool:
        verified = dict(pool.map(verify,checks))
    records = []
    for finding,plan in zip(findings,plans):
        accepted = bool(plan and verified.get(plan))
        record = dict(fingerprint=finding['Fingerprint'],rule=finding['RuleID'],file=finding['File'],
                      line=finding['StartLine'],columns=[finding['StartColumn'],finding['EndColumn']],
                      classification='VERIFIED_PUBLIC_GIT_REFERENCE' if accepted else 'BLOCKED_UNCLASSIFIED_FINDING',
                      reason=('EXACT_REFERENCE_AND_OBJECT_VERIFIED' if accepted else
                              ('REFERENCE_OBJECT_UNAVAILABLE_OR_UNVERIFIED' if plan else 'UNQUALIFIED_RULE_SOURCE_OR_SPAN')))
        if accepted:
            record['proof'] = dict(kind=plan[0],verification='EXACT_GITILES_COMMIT_OBJECT' if plan[0]=='upstream_go_commit' else 'EXACT_LOCAL_GIT_COMMIT_OBJECT',
                                   source_commit=finding['Commit'],
                                   source_blob_sha256=hashlib.sha256(read_line(finding).encode()).hexdigest())
            if plan[1]:
                record['proof']['url'] = plan[1]
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
        result=qualify(json.loads(raw),args.scanner_exit)
        result['raw_report_sha256']=hashlib.sha256(raw).hexdigest()
    except (OSError,ValueError,KeyError,TypeError,UnicodeError,subprocess.SubprocessError):
        result=dict(format='homecloud-secret-reference-evidence-v1',status='BLOCKED',error='Invalid or unavailable scanner/reference evidence')
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key != 'findings'},sort_keys=True))
    return 0 if result['status']=='PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
