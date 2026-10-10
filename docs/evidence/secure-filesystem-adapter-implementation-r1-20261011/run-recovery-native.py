import subprocess,json,os,sys
info=json.loads(subprocess.check_output(['docker','inspect','homecloud-preview-backend-1']))[0]
url=next(v.split('=',1)[1] for v in info['Config']['Env'] if v.startswith('DATABASE_URL='));network=next(iter(info['NetworkSettings']['Networks']))
root='/Users/aleksejkozemakin/Desktop/HomeCloud'
args=['docker','run','--rm','--user','1001:1001','--cap-drop','ALL','--network',network,'-e','HOMECLOUD_TEST_DATABASE_URL','--mount','type=bind,src='+root+'/backend/src,dst=/app/src,readonly','--mount','type=bind,src=/tmp/homecloud-r1-authoring/recovery.cjs,dst=/recovery.cjs,readonly','--tmpfs','/app/dist:uid=1001,gid=1001','--tmpfs','/qualified:uid=1001,gid=1001,mode=0700','--entrypoint','sh','homecloud-r1-tests:temporary','-c','npm run build && node /recovery.cjs']
with open('/tmp/homecloud-r1-authoring/recovery-native.log','w') as log:result=subprocess.run(args,env={**os.environ,'HOMECLOUD_TEST_DATABASE_URL':url},stdout=log,stderr=subprocess.STDOUT)
print('native recovery exit='+str(result.returncode));sys.exit(result.returncode)
