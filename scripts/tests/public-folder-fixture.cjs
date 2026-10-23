/* Local disposable resources only; no production endpoints or backend edits. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const evidence=process.env.HOMECLOUD_BROWSER_WORKDIR;
if(!evidence||!path.isAbsolute(evidence))throw Error('Absolute HOMECLOUD_BROWSER_WORKDIR required');
fs.mkdirSync(evidence,{recursive:true});
if(fs.realpathSync(evidence).startsWith(fs.realpathSync(root)+path.sep))throw Error('External disposable workdir required');
const privatePath=path.join(evidence,'fixture-private.json');
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(process.argv[2]==='cleanup'){
 const state=JSON.parse(fs.readFileSync(privatePath));
 if(!/^hc-public-folder-[a-f0-9]{10}$/.test(state.id))throw Error('Unexpected resource owner');
 for(const container of state.containers){if(!container.startsWith(state.id+'-'))throw Error('Not owned');docker(['rm','-f',container]);}
 for(const volume of state.volumes){if(!volume.startsWith(state.id+'-'))throw Error('Not owned');docker(['volume','rm',volume]);}
 if(state.network!==state.id+'-net')throw Error('Not owned');docker(['network','rm',state.network]);
 fs.unlinkSync(privatePath);fs.writeFileSync(path.join(evidence,'cleanup.json'),JSON.stringify({id:state.id,cleaned:true}));
 console.log('Owned disposable resources removed');
}else{
 if(fs.existsSync(privatePath))throw Error('Existing fixture: cleanup first');
 if(!fs.existsSync(path.join(root,'frontend/dist/index.html')))throw Error('Build frontend first');
 fs.cpSync(path.join(root,'frontend/dist'),path.join(evidence,'candidate-dist'),{recursive:true});
 fs.mkdirSync(path.join(evidence,'cert'),{recursive:true});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(evidence,'cert/key.pem'),'-out',path.join(evidence,'cert/cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
 fs.chmodSync(path.join(evidence,'cert/key.pem'),0o644);
 const id='hc-public-folder-'+crypto.randomBytes(5).toString('hex'),password=crypto.randomBytes(24).toString('hex');
 const state={id,network:id+'-net',containers:[],volumes:[],controlKey:crypto.randomBytes(24).toString('hex'),ports:{}};
 const save=()=>fs.writeFileSync(privatePath,JSON.stringify(state,null,2),{mode:0o600});save();
 try{
 docker(['network','create',state.network]);
 const database=id+'-db';docker(['run','-d','--name',database,'--network',state.network,'--network-alias','fixture-db','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_DB=frontend_ssd_fixture','-e','POSTGRES_USER=fixture','-e','POSTGRES_PASSWORD='+password,'postgres:16-alpine']);state.containers.push(database);save();
 const name=id+'-backend',volume=id+'-ssd';docker(['volume','create',volume]);state.volumes.push(volume);save();
 docker(['run','-d','--name',name,'--network',state.network,'-p','127.0.0.1::3000','--mount',`type=volume,source=${volume},target=/ssd`,'--mount',`type=bind,source=${root}/backend/src,target=/candidate-src,readonly`,'--mount',`type=bind,source=${root}/backend/package.json,target=/candidate-package.json,readonly`,'--mount',`type=bind,source=${root}/backend/package-lock.json,target=/candidate-package-lock.json,readonly`,'--mount',`type=bind,source=${__dirname},target=/fixture,readonly`,'--mount',`type=bind,source=${evidence}/candidate-dist,target=/candidate-dist,readonly`,'--mount',`type=bind,source=${evidence}/candidate-dist,target=/baseline-dist,readonly`,'--mount',`type=bind,source=${evidence}/cert,target=/cert,readonly`,'-e','HOMECLOUD_BROWSER_FIXTURE=1','-e','FIXTURE_SSD=false','-e','FIXTURE_CONTROL_KEY='+state.controlKey,'-e',`DATABASE_URL=postgresql://fixture:${password}@fixture-db:5432/frontend_ssd_fixture`,'-e','STORAGE_PATH=/storage','-e','UPLOAD_SSD_PATH=/ssd','-e','UPLOAD_SSD_RECOVERY_MODE=manual','-e','FRONTEND_URL=http://localhost','homecloud-stage24-candidate:arm64','sh','-c','cp -R /candidate-src/. /app/src/ && cp /candidate-package.json /app/package.json && cp /candidate-package-lock.json /app/package-lock.json && npm ci --no-audit --no-fund && npm run build && mkdir -p /storage && chown -R 1001:1001 /storage /ssd && cp /fixture/public-folder-fixture-server.cjs /app/test/public-folder-fixture.cjs && su -s /bin/sh nextjs -c "node /app/test/public-folder-fixture.cjs"']);state.containers.push(name);state.ports.public=Number(docker(['port',name,'3000/tcp']).split(':').at(-1));save();
 console.log(JSON.stringify({id,url:'https://127.0.0.1:'+state.ports.public}));
 }catch(error){save();console.error(String(error.stderr||error.message).replaceAll(password,'[redacted]').replaceAll(state.controlKey,'[redacted]'));process.exitCode=1;}
}
