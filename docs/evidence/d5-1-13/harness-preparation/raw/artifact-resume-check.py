import hashlib
import importlib.util
import json
from pathlib import Path
import time
import urllib.request
from datetime import datetime,timezone
ROOT=Path('/Users/aleksejkozemakin/.codex/.chatgpt-projects/g-p-6aaa72ceff208191895b0fd466f3e892/d5-ci')
OUT=ROOT/'docs/evidence/d5-1-13/harness-preparation/raw/artifact-resume-result.json'
PARTIAL=Path('/private/tmp/d513-artifact-transport-gxw004ja/artifact.zip')
TOTAL=116311061
OFFSET=87556096
TIMEOUT=180
started=time.monotonic()
deadline=started+TIMEOUT
result={'attempt':2,'max_attempts':2,'status':'NOT_VERIFIED','checked_at_utc':datetime.now(timezone.utc).isoformat(),'timeout_seconds':TIMEOUT,'expected_bytes':TOTAL,'start_bytes':OFFSET,'remote_mutations':False,'production':'NO_GO','signed_urls_logged':False,'full_redownload_allowed':False}
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path)
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def remaining():
 value=deadline-time.monotonic()
 if value<=0:raise TimeoutError()
 return min(value,15)
try:
 a=load('artifact',ROOT/'experiments/d5-1-13/artifact.py')
 prepare=load('prepare',ROOT/'ops/postgres/prepare.py')
 if not PARTIAL.is_file() or PARTIAL.is_symlink() or PARTIAL.stat().st_size!=OFFSET:raise ValueError('retained prefix mismatch')
 opener=urllib.request.build_opener(a.NoRedirect()).open
 signed=a.fresh_url(deadline-time.monotonic())
 head=urllib.request.Request(signed,method='HEAD',headers={'Accept-Encoding':'identity'})
 with opener(head,timeout=remaining()) as response:
  etag=response.headers.get('ETag','')
  if response.status!=200 or response.headers.get('Content-Length')!=str(TOTAL) or not a.re.fullmatch(r'"[^"\r\n]+"',etag):raise ValueError('HEAD identity mismatch')
  result.update({'head_status':response.status,'strong_etag':True})
 request=urllib.request.Request(signed,headers={'Accept-Encoding':'identity','Range':f'bytes={OFFSET}-','If-Match':etag})
 with opener(request,timeout=remaining()) as response:
  result['http_status']=response.status
  expected_range=f'bytes {OFFSET}-{TOTAL-1}/{TOTAL}'
  if (response.status!=206 or response.headers.get('Content-Range')!=expected_range or response.headers.get('ETag')!=etag or response.headers.get('Content-Length')!=str(TOTAL-OFFSET) or response.headers.get('Content-Encoding','identity')!='identity'):raise ValueError('suffix response mismatch')
  result.update({'content_range':expected_range,'etag_matches_head':True})
  with PARTIAL.open('r+b') as target:
   target.seek(OFFSET)
   while True:
    budget=remaining()
    raw=getattr(getattr(response,'fp',None),'raw',None)
    sock=getattr(raw,'_sock',None)
    if sock is not None:sock.settimeout(budget)
    block=response.read1(min(1024*1024,TOTAL-target.tell()+1))
    if not block:break
    if target.tell()+len(block)>TOTAL:raise ValueError('suffix size overflow')
    target.write(block);target.flush()
 if PARTIAL.stat().st_size!=TOTAL:raise ValueError('incomplete suffix')
 result['zip_sha256']=a.sha(PARTIAL)
 if result['zip_sha256']!=a.ZIP_SHA:raise ValueError('pinned ZIP mismatch')
 candidate=PARTIAL.with_name('candidate.oci.tar')
 with a.zipfile.ZipFile(PARTIAL) as zipped:
  if zipped.namelist()!=['candidate.oci.tar']:raise ValueError('ZIP member mismatch')
  member=zipped.getinfo('candidate.oci.tar')
  if not 0<member.file_size<a.MAX_TAR or member.flag_bits&1:raise ValueError('ZIP metadata mismatch')
  with zipped.open(member) as source,candidate.open('xb') as target:
   total=0
   while True:
    if deadline-time.monotonic()<=0:raise TimeoutError()
    block=source.read(1024*1024)
    if not block:break
    total+=len(block)
    if total>=a.MAX_TAR:raise ValueError('tar exceeds cap')
    target.write(block)
 result['identity']=prepare.verify_archive(candidate,prepare.load_lock())
 result['status']='REMOTE_EXACT_OCI_VERIFIED'
 result['candidate_path']=str(candidate)
except Exception as error:
 result['error_type']=type(error).__name__
finally:
 result['end_bytes']=PARTIAL.stat().st_size if PARTIAL.exists() else None
 result['elapsed_seconds']=round(time.monotonic()-started,3)
 OUT.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
