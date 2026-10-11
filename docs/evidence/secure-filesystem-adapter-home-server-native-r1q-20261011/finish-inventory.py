"""Read-only inventory of qualification ownership, isolation and final host metadata."""
import json, os, pathlib, subprocess
P=pathlib.Path('/home/hs/homecloud-test')
S=pathlib.Path('/mnt/1TB/homecloud-test')
assert json.loads((P/'.homecloud-r1q-run.json').read_text())['initial_head']=='37190a8d3e77cc80314790df71d74e0ac121e143'
def out(args): return subprocess.check_output(args,text=True,cwd=P).strip()
for root in (P,S):
 st=root.lstat(); assert root.is_dir() and not root.is_symlink() and st.st_uid==1000 and st.st_gid==1000 and st.st_mode&0o777==0o700
 print('SAFE_ROOT',root,st.st_uid,st.st_gid,oct(st.st_mode&0o777))
print(out(['findmnt','-T',str(S),'-n','-o','TARGET,SOURCE,FSTYPE,OPTIONS']))
print(out(['findmnt','-T',str(P),'-n','-o','TARGET,SOURCE,FSTYPE,OPTIONS']))
print(out(['free','-b'])); print(out(['vmstat','1','3']))
print(out(['df','-B1',str(P),str(S)]))
print(out(['du','-sh',str(P),str(S)]))
print('LISTENERS\n'+out(['ss','-lnt']))
print('CONTAINERS')
ids=out(['docker','ps','-q']).splitlines()
for cid in ids:
 print(out(['docker','inspect','--format','{{.Id}}|{{.Name}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}',cid]))
 print(out(['docker','inspect','--format','{{.Name}}|ports={{json .HostConfig.PortBindings}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',cid]))
for kind,plural in [('network','networks'),('volume','volumes')]:
 objs=out(['docker',kind,'ls','--filter','label=com.docker.compose.project=homecloud-test','-q']).splitlines()
 for obj in objs:
  rec=json.loads(out(['docker',kind,'inspect',obj]))[0]
  if kind=='network': result={k:rec[k] for k in ('Name','Driver','Internal','Labels','Containers')}
  else: result={k:rec[k] for k in ('Name','Driver','Labels')}
  print(kind.upper(),json.dumps(result))
print('CONTEXT',out(['docker','context','show']))
print('DAEMON',out(['docker','info','--format','{{.Architecture}}|{{.Driver}}|{{json .SecurityOptions}}']))
