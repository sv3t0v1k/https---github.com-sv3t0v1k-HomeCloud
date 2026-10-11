import hashlib,json,os,subprocess,sys
from pathlib import Path
project=Path('/home/hs/homecloud-test/r2-identity-20261011-01a12a10')
data=Path('/mnt/1TB/homecloud-test/r2-identity-20261011-01a12a10/a')
image='sha256:8694a91c8306b7f43e6d5d93f693973ddb5d302010dee477d0e6fc7f83cb4e52'
source=json.load(sys.stdin)['source'].replace('O_PATH','O_RDONLY')
assert project.is_dir() and not project.is_symlink() and project.stat().st_uid==os.getuid()==1000
src=project/'identity-probe-readonly.c'; binary=project/'identity-probe-readonly'
with src.open('x') as f: f.write(source)
def run(args,check=True):
    return subprocess.run(args,text=True,capture_output=True,check=check,timeout=45)
run(['cc','-std=c11','-O2','-Wall','-Wextra','-Werror','-static',str(src),'-o',str(binary)])
baseline={x['test']:x['result'] for x in json.loads((project/'results.json').read_text())}
def ident(x):
    h=x['empty']; assert h['rc']==0
    return h['type'],h['bytes'],h['hex']
records=[]
for label,root,expected in [('ext4',data,baseline['same-path-new-directory']),('xfs-root','/mnt/data',baseline['xfs-root-readonly-process-1'])]:
    host=json.loads(run([str(binary),str(root)]).stdout)
    assert ident(host)==ident(expected) and host['empty']==host['dot']
    name='r2-identity-20261011-01a12a10-readonly-'+label
    args=['docker','run','--name',name,'--pull','never','--read-only','--cap-drop','ALL',
          '--security-opt','no-new-privileges','--network','none','--memory','64m','--memory-swap','64m',
          '--cpus','0.25','--pids-limit','32','--user','1000:1000','--label','homecloud.research=MS-3B-R2.1',
          '--mount',f'type=bind,src={binary},dst=/probe,readonly',
          '--mount',f'type=bind,src={root},dst=/qualified,readonly',
          '--entrypoint','/probe',image,'/qualified']
    try:
        container=json.loads(run(args).stdout)
        assert ident(container)==ident(host)
        assert container['process_security']['CapEff']=='0000000000000000'
        assert container['process_security']['CapBnd']=='0000000000000000'
        assert container['process_security']['Seccomp']=='2'
        assert container['process_security']['NoNewPrivs']=='1'
        oom=run(['docker','inspect','--format','{{.State.OOMKilled}}',name]).stdout.strip()
        assert oom=='false'
        record={'test':'readonly-fd-'+label,'host':host,'container':container,'O_PATH_comparison_equal':True,'OOMKilled':False}
        print(json.dumps(record),flush=True); records.append(record)
    finally:
        run(['docker','rm','-f',name],check=False)
records.append({'test':'readonly-probe-sha256','source':hashlib.sha256(source.encode()).hexdigest(),'binary':hashlib.sha256(binary.read_bytes()).hexdigest()})
print(json.dumps(records[-1]),flush=True)
(project/'readonly-results.json').write_text(json.dumps(records,indent=2))
