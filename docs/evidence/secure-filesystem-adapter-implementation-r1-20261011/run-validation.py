import subprocess,json,os,sys
root='/Users/aleksejkozemakin/Desktop/HomeCloud'
info=json.loads(subprocess.check_output(['docker','inspect','homecloud-preview-backend-1']))[0]
url=next(v.split('=',1)[1] for v in info['Config']['Env'] if v.startswith('DATABASE_URL='))
network=next(iter(info['NetworkSettings']['Networks']))
args=['docker','run','--rm','--user','1001:1001','--cap-drop','ALL','--network',network,'-e','HOMECLOUD_TEST_DATABASE_URL','--mount','type=bind,src='+root+'/backend/src,dst=/app/src,readonly','--mount','type=bind,src='+root+'/backend/bench,dst=/app/bench,readonly','--tmpfs','/app/dist:uid=1001,gid=1001','--entrypoint','sh','homecloud-r1-tests:temporary','-c',sys.argv[1]]
env={**os.environ,'HOMECLOUD_TEST_DATABASE_URL':url}
with open('/tmp/homecloud-r1-authoring/'+sys.argv[2],'w') as log:
 result=subprocess.run(args,env=env,stdout=log,stderr=subprocess.STDOUT)
print('validation exit='+str(result.returncode));sys.exit(result.returncode)
