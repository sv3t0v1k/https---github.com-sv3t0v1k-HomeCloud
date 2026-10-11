"""Execute one explicitly named qualification service and record bounded resource samples."""
import json
from pathlib import Path
import subprocess
import sys
import time

P=Path('/home/hs/homecloud-test')
assert json.loads((P/'.homecloud-r1q-run.json').read_text())['initial_head']=='37190a8d3e77cc80314790df71d74e0ac121e143'
service=sys.argv[1];stage=sys.argv[2];command=sys.argv[3:]  # one shell command if overriding
assert service in ('tests','persistent','adversarial','recovery','http','production-probe','validation')
assert stage.replace('-','').isalnum()
logs=P/'logs';logs.mkdir(mode=0o700,exist_ok=True)
if (logs/(stage+'.txt')).exists():raise SystemExit('STOP existing stage log')
def output(args):return subprocess.check_output(args,cwd=P,text=True).strip()
args=['docker','compose','-p','homecloud-test','run','-d','--no-deps',service]+command
cid=output(args).splitlines()[-1]
assert len(cid)==64 and all(c in '0123456789abcdef' for c in cid)
def info():
    return json.loads(output(['docker','inspect','--format','{"state":{{json .State}},"labels":{{json .Config.Labels}},"user":{{json .Config.User}},"host":{{json .HostConfig}}}',cid]))
observed=[];blocked=False;started=time.monotonic();last=info()
assert last['labels']['com.docker.compose.project']=='homecloud-test'
try:
    while last['state']['Running']:
        available=int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
        sample={'elapsed_s':round(time.monotonic()-started,2),'host_available_bytes':available}
        try:sample['docker_stats']=output(['docker','stats','--no-stream','--format','{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}',cid])
        except subprocess.CalledProcessError:pass
        observed.append(sample)
        if available<2*1024**3 or time.monotonic()-started>900:
            blocked=True;subprocess.run(['docker','stop','--time','5',cid],check=True);break
        time.sleep(2);last=info()
    last=info()
    with (logs/(stage+'.txt')).open('w') as log:subprocess.run(['docker','logs',cid],stdout=log,stderr=subprocess.STDOUT,check=True)
    h=last['host']
    record={'service':service,'container':cid,'exit_code':last['state']['ExitCode'],'oom_killed':last['state']['OOMKilled'],'resource_stop':blocked,'duration_s':round(time.monotonic()-started,2),'runtime':{'user':last['user'],'memory':h['Memory'],'memory_swap':h['MemorySwap'],'nano_cpus':h['NanoCpus'],'cap_drop':h['CapDrop'],'security_opt':h['SecurityOpt'],'privileged':h['Privileged'],'network_mode':h['NetworkMode'],'readonly_rootfs':h['ReadonlyRootfs'],'port_bindings':h['PortBindings']},'samples':observed}
    (logs/(stage+'-resources.json')).write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps({k:record[k] for k in ('service','exit_code','oom_killed','resource_stop','duration_s')}))
finally:
    current=info()
    if current['state']['Running']:subprocess.run(['docker','stop','--time','5',cid],check=True)
    subprocess.run(['docker','rm',cid],check=True,stdout=subprocess.DEVNULL)
raise SystemExit(1 if blocked else last['state']['ExitCode'])
