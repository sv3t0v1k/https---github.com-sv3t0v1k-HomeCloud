'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
if(!process.env.HOMECLOUD_BROWSER_WORKDIR||!path.isAbsolute(process.env.HOMECLOUD_BROWSER_WORKDIR))throw Error('Absolute HOMECLOUD_BROWSER_WORKDIR outside repository required');
const evidence=path.resolve(process.env.HOMECLOUD_BROWSER_WORKDIR);
fs.mkdirSync(evidence,{recursive:true});
const resolvedEvidence=fs.realpathSync(evidence),resolvedRoot=fs.realpathSync(root);
if(resolvedEvidence===resolvedRoot||resolvedEvidence.startsWith(resolvedRoot+path.sep))throw Error('Fixture workdir must be outside repository');
fs.mkdirSync(evidence,{recursive:true});
for(const directory of ['candidate-dist','baseline-dist'])if(!fs.existsSync(path.join(evidence,directory,'index.html')))throw Error('Build static fixture artifact first: '+directory);
const id='hc-frontend-ssd-'+crypto.randomBytes(5).toString('hex');
const password=crypto.randomBytes(24).toString('hex'),controlKey=crypto.randomBytes(24).toString('hex');
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const owned={id,network:id+'-net',database:id+'-db',containers:[],volumes:[],controlKey,ports:{}};
fs.writeFileSync(path.join(evidence,'fixture-private.json'),JSON.stringify(owned,null,2),{mode:0o600,flag:'wx'});
function save(){fs.writeFileSync(path.join(evidence,'fixture-private.json'),JSON.stringify(owned,null,2));}
try{
 docker(['network','create',owned.network]);
 docker(['run','-d','--name',owned.database,'--network',owned.network,'--network-alias','fixture-db','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_DB=frontend_ssd_fixture','-e','POSTGRES_USER=fixture','-e','POSTGRES_PASSWORD='+password,'postgres:16-alpine']);owned.containers.push(owned.database);save();
 for(const mode of ['on','off']){
  const name=id+'-'+mode,volume=name+'-ssd';docker(['volume','create',volume]);owned.volumes.push(volume);save();
  const args=['run','-d','--name',name,'--network',owned.network,'-p','127.0.0.1::3000','--mount',`type=volume,source=${volume},target=/ssd`,'--mount',`type=bind,source=${root}/backend/src,target=/candidate-src,readonly`,'--mount',`type=bind,source=${__dirname},target=/fixture,readonly`,'--mount',`type=bind,source=${evidence}/candidate-dist,target=/candidate-dist,readonly`,'--mount',`type=bind,source=${evidence}/baseline-dist,target=/baseline-dist,readonly`,'-e','HOMECLOUD_BROWSER_FIXTURE=1','-e','FIXTURE_SSD='+String(mode==='on'),'-e','FIXTURE_CONTROL_KEY='+controlKey,'-e',`DATABASE_URL=postgresql://fixture:${password}@fixture-db:5432/frontend_ssd_fixture`,'-e','STORAGE_PATH=/storage','-e','UPLOAD_SSD_PATH=/ssd','-e','UPLOAD_SSD_RECOVERY_MODE=manual','-e','FRONTEND_URL=http://localhost','homecloud-stage24-candidate:arm64','sh','-c','cp -R /candidate-src/. /app/src/ && npm run build && mkdir -p /storage && chown -R 1001:1001 /storage /ssd && cp /fixture/server.cjs /app/test/frontend-ssd-browser-server.cjs && su -s /bin/sh nextjs -c "node /app/test/frontend-ssd-browser-server.cjs"'];
  docker(args);owned.containers.push(name);owned.ports[mode]=Number(docker(['port',name,'3000/tcp']).split(':').at(-1));save();
 }
 console.log(JSON.stringify({id,urls:Object.fromEntries(Object.entries(owned.ports).map(([k,v])=>[k,'http://127.0.0.1:'+v]))}));
}catch(error){save();console.error(String(error.stderr||error.message).replaceAll(password,'[redacted]').replaceAll(controlKey,'[redacted]'));process.exitCode=1;}
