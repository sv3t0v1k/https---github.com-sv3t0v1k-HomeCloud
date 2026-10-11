"""Stop/remove only the confirmed disposable homecloud-test stack; keep evidence and images."""
import json,pathlib,subprocess
P=pathlib.Path('/home/hs/homecloud-test')
assert json.loads((P/'.homecloud-r1q-run.json').read_text())['initial_head']=='37190a8d3e77cc80314790df71d74e0ac121e143'
def out(args):return subprocess.check_output(args,text=True,cwd=P).strip()
ids=out(['docker','ps','-aq','--filter','label=com.docker.compose.project=homecloud-test']).splitlines()
assert len(ids)==1,('unexpected owned containers',len(ids))
rec=json.loads(out(['docker','inspect',ids[0]]))[0]
assert rec['Name']=='/homecloud-test-pg-1' and rec['Config']['Labels']['com.docker.compose.service']=='pg'
vol=json.loads(out(['docker','volume','inspect','homecloud-test_pg-data']))[0]
assert vol['Labels']['com.docker.compose.project']=='homecloud-test'
assert set(out(['docker','network','ls','-q','--no-trunc','--filter','label=com.docker.compose.project=homecloud-test']).splitlines())==set(out(['docker','network','inspect','--format','{{.Id}}','homecloud-test_build','homecloud-test_qualification']).splitlines())
subprocess.run(['docker','compose','-p','homecloud-test','down','--volumes'],cwd=P,check=True)
network=json.loads(out(['docker','network','inspect','homecloud-test_build']))[0]
assert network['Labels']['com.docker.compose.project']=='homecloud-test' and not network['Containers']
subprocess.run(['docker','network','rm','homecloud-test_build'],check=True)
for args in (['docker','ps','-aq'],['docker','network','ls','-q'],['docker','volume','ls','-q']):
 assert not out(args+['--filter','label=com.docker.compose.project=homecloud-test'])
print('OWN_CONTAINER_NETWORK_VOLUME_CLEANUP=PASS; images/config/source/logs/disposable fixture bytes retained; existing services not targeted')
