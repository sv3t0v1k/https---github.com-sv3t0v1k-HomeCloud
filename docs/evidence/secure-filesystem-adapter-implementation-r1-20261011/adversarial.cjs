// Disposable fixture only; never mount canonical storage or connect DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Worker}=require('node:worker_threads');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {SecureFilesystem}=require('/app/dist/uploads/secure-filesystem');
const {abortableDiskStorage}=require('/app/dist/uploads/abortable-disk-storage');
const {UploadWorkspaceResolver,LEGACY_UPLOAD_WORKSPACE}=require('/app/dist/uploads/upload-workspace');
const {StorageService}=require('/app/dist/storage/storage.service');
const {ConfigService}=require('/app/node_modules/@nestjs/config');
const {legacyBinding,markerContents,IDENTITY_MARKER}=require('/app/dist/storage/storage-mount-registry');
const root='/qualified',outside='/tmp/outside-r1';
const bytes=Buffer.from([0,255,128,0,1]);
const report={platform:process.platform,architecture:process.arch,kernel:fs.readFileSync('/proc/sys/kernel/osrelease','utf8').trim(),uid:process.getuid(),scope:'Docker Desktop/LinuxKit; disposable tmpfs; actual compiled production modules; no canonical rollout'};
assert.equal(process.getuid(),1001);assert.equal(fs.existsSync('/storage'),false);assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\s+0000000000000000/);
assert.deepEqual(fs.readdirSync(root),[]);fs.mkdirSync(outside);fs.writeFileSync(outside+'/preserved',bytes);
let boundary,storage,resolver;
async function multer(engine,req=new EventEmitter()){req.res=new EventEmitter();return new Promise(resolve=>engine._handleFile(req,{stream:Readable.from(bytes)},(error,file)=>resolve({error,file})));}
(async()=>{
 process.env.NODE_ENV='production';process.env.STORAGE_PATH=root;
 fs.writeFileSync(root+'/'+IDENTITY_MARKER,markerContents(legacyBinding(root,true)),{mode:0o600});fs.mkdirSync(root+'/.tmp');
 storage=new StorageService(new ConfigService());resolver=new UploadWorkspaceResolver(storage);const ingress=resolver.ingress(LEGACY_UPLOAD_WORKSPACE);resolver.filesystem().mkdir(ingress);
 const engine=abortableDiskStorage(ingress,p=>{resolver.assertPath(p);fs.renameSync(ingress,root+'/.tmp/saved-ingress');fs.symlinkSync(outside,ingress);},()=>resolver.filesystem());
 const attack=await multer(engine);assert.ok(attack.error);assert.deepEqual(fs.readdirSync(outside),['preserved']);assert.deepEqual(fs.readFileSync(outside+'/preserved'),bytes);
 report.multer={guard:'real production resolver; deterministic symlink swap immediately after guard',result:'FAIL_CLOSED',errorCode:attack.error.code,outsideWrittenBytes:0};
 fs.unlinkSync(ingress);fs.renameSync(root+'/.tmp/saved-ingress',ingress);
 const success=await multer(abortableDiskStorage(ingress,p=>resolver.assertPath(p),()=>resolver.filesystem()));assert.ifError(success.error);assert.deepEqual(fs.readFileSync(success.file.path),bytes);resolver.filesystem().remove(success.file.path);
 boundary=new SecureFilesystem(root,fs.statSync(root));boundary.mkdir(root+'/chunks');
 for(const key of ['../escape','chunks/../../escape','chunks/../escape','nul\0x'])assert.throws(()=>boundary.open(root+'/'+key,'wx'));
 fs.symlinkSync(outside,root+'/chunks/leaf');assert.throws(()=>boundary.open(root+'/chunks/leaf'));boundary.remove(root+'/chunks/leaf');
 const exdev=new SecureFilesystem('/exdev',fs.statSync('/exdev'));exdev.write('/exdev/source',bytes);assert.throws(()=>exdev.rename('/exdev/source','/exdev/nested/destination'),e=>e.code==='EXDEV');assert.deepEqual(fs.readFileSync('/exdev/source'),bytes);assert.deepEqual(fs.readdirSync('/exdev/nested'),[]);exdev.close();boundary.write(root+'/source',bytes);report.exdev={actualNestedMount:true,result:'EXDEV',sourceRetained:true,copyFallback:false};
 const stop=new SharedArrayBuffer(8),state=new Int32Array(stop);
 const worker=new Worker(`const fs=require('node:fs');const state=new Int32Array(require('node:worker_threads').workerData);while(!Atomics.load(state,0)){try{fs.renameSync('/qualified/chunks','/qualified/saved-chunks');fs.symlinkSync('/tmp/outside-r1','/qualified/chunks');Atomics.add(state,1,1);fs.unlinkSync('/qualified/chunks');fs.renameSync('/qualified/saved-chunks','/qualified/chunks');}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}}`,{eval:true,workerData:stop});
 let successCount=0,refused=0;try {
  await new Promise(r=>setTimeout(r,40));
  for(let i=0;i<2000;i++){
   let fd;try {fd=boundary.open(root+'/chunks/'+i,'wx');fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);successCount++;}
   catch(e){refused++;assert.ok(['ENOENT','ELOOP','EXDEV','ESECUREFS'].includes(e.code),e.code);}
   finally{if(fd!==undefined)fs.closeSync(fd);}
   if(i%16===0)await new Promise(r=>setImmediate(r));
  }
 }finally{Atomics.store(state,0,1);await new Promise((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(new Error('worker exit')));worker.once('error',reject);});}
 assert.ok(Atomics.load(state,1)>0);assert.deepEqual(fs.readdirSync(outside),['preserved']);assert.deepEqual(fs.readFileSync(outside+'/preserved'),bytes);
 report.concurrency={attempts:2000,successes:successCount,explicitRefusals:refused,ancestorSwaps:Atomics.load(state,1),outsideWrittenBytes:0};
 boundary.mkdir(root+'/cleanup');fs.symlinkSync(outside,root+'/cleanup/link');boundary.remove(root+'/cleanup',true);assert.deepEqual(fs.readFileSync(outside+'/preserved'),bytes);
 report.cleanup={symlinkOutsidePreserved:true};
 const childCode=`const fs=require('node:fs');const {SecureFilesystem}=require('/app/dist/uploads/secure-filesystem');const b=new SecureFilesystem('/qualified',fs.statSync('/qualified'));b.mkdir('/qualified/crash');b.write('/qualified/crash/0',Buffer.from([0,255,128,0,1]));b.sync('/qualified/crash',true);process.send('synced');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['-e',childCode],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',()=>child.kill('SIGKILL'));child.once('exit',(_code,signal)=>signal==='SIGKILL'?resolve():reject(new Error('child not SIGKILL')));});
 const fresh=new SecureFilesystem(root,fs.statSync(root));const crashFd=fresh.open(root+'/crash/0');assert.deepEqual(fs.readFileSync(crashFd),bytes);fs.closeSync(crashFd);fresh.remove(root+'/crash',true);fresh.close();
 report.crashRestart={result:'PASS',scope:'SIGKILL after file+directory fsync; fresh capability reads retained bytes; not power-loss qualification'};
 // Repeat teardown/acquisition to observe FD ownership. No user paths enter helper.
 const count=()=>fs.readdirSync('/proc/self/fd').length;const baseline=count();for(let i=0;i<100;i++){const b=new SecureFilesystem(root,fs.statSync(root));const fd=b.open(root+'/source');fs.closeSync(fd);b.close();}assert.equal(count(),baseline);report.fdLifecycle={cycles:100,leaks:0};
 boundary.remove(root+'/chunks',true);boundary.remove(root+'/source');report.result='LOCALLY_VERIFIED';report.secureOpen=false;report.production='NOT_READY/NO_GO';
})().then(()=>{boundary?.close();resolver?.close();storage?.onModuleDestroy();fs.rmSync(outside,{recursive:true,force:true});console.log('HCRESULT='+JSON.stringify(report));}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{boundary?.close();resolver?.close();storage?.onModuleDestroy();});
