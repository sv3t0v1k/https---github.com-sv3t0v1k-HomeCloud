"""Изолированная диагностика Rosetta/openat2, без canonical roots/DB и без qualification PASS."""
import argparse,json,pathlib,shutil,subprocess,uuid,hashlib
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo',required=True,type=pathlib.Path)
parser.add_argument('--output',required=True,type=pathlib.Path)
a=parser.parse_args();repo=a.repo.resolve();out=a.output.resolve();source=pathlib.Path(__file__).resolve().parent
if out.exists() and any(out.iterdir()):raise SystemExit('Output должен быть пустой директорией')
if not (repo/'backend/native/secure-fs.c').is_file():raise SystemExit('Неверный repo')
info=json.loads(subprocess.check_output(['docker','info','--format','{{json .}}']))
if info['Architecture'] not in ['aarch64','arm64'] or info['OperatingSystem']!='Docker Desktop':raise SystemExit('Этот harness воспроизводит Desktop ARM/Rosetta; native qualification — отдельный gate')
out.mkdir(parents=True,exist_ok=True)
for name in ['syscall-probe.c','artifact-probe.cjs']:
 shutil.copyfile(source/name,out/name)
shutil.copyfile(repo/'docs/evidence/secure-filesystem-adapter-implementation-r1-20261011/amd64-failclosed.cjs',out/'failclosed.cjs')
prefix='homecloud-r1q-'+uuid.uuid4().hex[:8]
images={k:prefix+'-'+k+':temporary' for k in ['amd64','amd64-builder','arm64-tests']};built=[]
def run(label,cmd,cwd=None):
 with (out/(label+'.log')).open('w') as f:
  f.write('COMMAND='+json.dumps(cmd)+'\n');f.flush()
  r=subprocess.run(cmd,cwd=cwd,stdout=f,stderr=subprocess.STDOUT,timeout=600)
  f.write('\nEXIT='+str(r.returncode)+'\n')
 if r.returncode:raise RuntimeError(label+' failed: '+str(r.returncode))
 return (out/(label+'.log')).read_text()
def base(arch):
 return ['docker','run','--rm','--platform','linux/'+arch,'--user','1001:1001','--cap-drop','ALL','--network','none','--security-opt','no-new-privileges=true','--read-only','--tmpfs','/qualified:uid=1001,gid=1001,mode=0700','--mount','type=bind,src='+str(out)+',dst=/evidence,readonly']
try:
 for key,flags in [('amd64',['--platform','linux/amd64']),('amd64-builder',['--platform','linux/amd64','--target','builder']),('arm64-tests',['--platform','linux/arm64','-f','native/Dockerfile.tests'])]:
  built.append(images[key]);run(key+'-build',['docker','build','--pull=false']+flags+['-t',images[key],'.'],cwd=repo/'backend')
 for arch,key in [('amd64','amd64-builder'),('arm64','arm64-tests')]:
  cmd=base(arch)+['--tmpfs','/tmp:uid=1001,gid=1001,mode=0700','--entrypoint','sh',images[key],'-c','cc -static -std=c11 -Wall -Wextra -Werror /evidence/syscall-probe.c -o /tmp/probe && cat /tmp/probe']
  with (out/('probe-'+arch)).open('wb') as f:subprocess.run(cmd,stdout=f,check=True,timeout=90)
  (out/('probe-'+arch)).chmod(0o755)
 for arch,key in [('amd64','amd64'),('arm64','arm64-tests')]:
  log=run(arch+'-direct',base(arch)+['--entrypoint','/evidence/probe-'+arch,images[key]])
  expected='raw full-resolve result=-38 errno=38' if arch=='amd64' else 'errno=0'
  if expected not in log:raise RuntimeError('Изменился runtime результат; нужна новая интерпретация '+arch)
  if arch=='amd64' and '/run/rosetta/rosetta' not in log:raise RuntimeError('Rosetta не подтверждена')
  run(arch+'-artifact',base(arch)+['--entrypoint','node',images[key],'/evidence/artifact-probe.cjs'])
 run('amd64-paired',base('amd64')+['--entrypoint','sh',images['amd64'],'-c','/evidence/probe-amd64 && /evidence/probe-arm64'])
 run('amd64-multer',base('amd64')+['--entrypoint','node',images['amd64'],'/evidence/failclosed.cjs'])
 for mode,label,expected in [('deny-openat2','arm64-restrictive-sentinel','raw full-resolve result=-13 errno=13'),('deny-exec-amd64','arm64-restrictive-exec-amd64','raw full-resolve result=-38 errno=38')]:
  log=run(label,base('arm64')+['--entrypoint','/evidence/probe-arm64',images['arm64-tests'],mode])
  if 'restrictive_filter rc=0' not in log or expected not in log:raise RuntimeError('Sentinel результат изменился')
 manifest={k:hashlib.sha256((out/k).read_bytes()).hexdigest() for k in ['syscall-probe.c','artifact-probe.cjs','probe-amd64','probe-arm64']}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print('Диагностика воспроизведена. Native AMD64 qualification остаётся BLOCKED_ENVIRONMENT.')
finally:
 for name in built:subprocess.run(['docker','image','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
