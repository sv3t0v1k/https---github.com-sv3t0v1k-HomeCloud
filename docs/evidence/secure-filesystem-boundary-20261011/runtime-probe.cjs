// Actual compiled HomeCloud boundary; only private tmpfs/scratch, never /storage or DB.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { ConfigService } = require('/app/node_modules/@nestjs/config');
const { StorageService } = require('/app/dist/storage/storage.service');
const { abortableDiskStorage } = require('/app/dist/uploads/abortable-disk-storage');
const { UploadWorkspaceResolver, LEGACY_UPLOAD_WORKSPACE } = require('/app/dist/uploads/upload-workspace');
const { markerContents,legacyBinding,linuxMountIdentity,IDENTITY_MARKER } = require('/app/dist/storage/storage-mount-registry');
assert.equal(process.getuid(),1001);
assert.equal(fs.existsSync('/storage'),false);
assert.equal(process.platform,'linux');
assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\s+0000000000000000/);
const root='/qualified';
assert.equal(JSON.parse(linuxMountIdentity(root,fs.readFileSync('/proc/self/mountinfo','utf8')).fingerprint)[5],'tmpfs');
assert.deepEqual(fs.readdirSync(root),[],'refuse non-empty /qualified fixture');
const scratch = fs.mkdtempSync('/tmp/hc-ms3br-runtime-');
const bytes=Buffer.from([0,255,128,0,1]);
const report={scope:'compiled production StorageService/resolver/Multer; NODE_ENV=production, isolated actual Linux tmpfs',secureOpen:false,activation:'disabled'};
const childSource = `
 const fs=require('node:fs');
 const {ConfigService}=require('/app/node_modules/@nestjs/config');
 const {StorageService}=require('/app/dist/storage/storage.service');
 const {UploadWorkspaceResolver,LEGACY_UPLOAD_WORKSPACE}=require('/app/dist/uploads/upload-workspace');
 process.env.NODE_ENV='production';
 let storage,resolver;
 try {
   storage=new StorageService(new ConfigService());resolver=new UploadWorkspaceResolver(storage);
   const p=resolver.root(LEGACY_UPLOAD_WORKSPACE),st=fs.lstatSync(p);
   console.log('HCRESULT='+JSON.stringify({accepted:true,dev:st.dev,ino:st.ino,pid:process.pid}));
 } catch(error) {
   console.log('HCRESULT='+JSON.stringify({accepted:false,error:error.message,pid:process.pid}));
 } finally {resolver?.close();storage?.onModuleDestroy();}
`;
function fresh(selectedRoot=root) {
 const child=spawnSync(process.execPath,['-e',childSource],{encoding:'utf8',env:{...process.env,NODE_ENV:'production',STORAGE_PATH:selectedRoot}});
 assert.equal(child.status,0,'fresh Node process must finish');
 const result=child.stdout.split('\n').find(x=>x.startsWith('HCRESULT='));
 assert.ok(result,'bounded child result');return JSON.parse(result.slice(9));
}
let storage,resolver;
(async()=>{
 const plain=scratch+'/plain';fs.mkdirSync(plain);
 fs.writeFileSync(path.join(plain,IDENTITY_MARKER),markerContents(legacyBinding(plain,true)),{mode:0o600,flag:'wx'});
 const plainAdmission=fresh(plain),absentAdmission=fresh(scratch+'/absent');
 assert.equal(plainAdmission.accepted,false);assert.equal(absentAdmission.accepted,false);
 assert.deepEqual(fs.readdirSync(plain),[IDENTITY_MARKER]);assert.equal(fs.existsSync(scratch+'/absent'),false);
 report.mountAdmission={plainCopiedMarker:plainAdmission,absentRoot:absentAdmission,noRootCreation:true};
 fs.writeFileSync(path.join(root,IDENTITY_MARKER),markerContents(legacyBinding(root,true)),{mode:0o600,flag:'wx'});
 const missing=fresh();assert.equal(missing.accepted,false);
 assert.equal(fs.existsSync(path.join(root,'.tmp')),false,'no mkdir on production absent workspace');
 fs.mkdirSync(path.join(root,'.tmp'));fs.writeFileSync(path.join(root,'.tmp','preserved-chunk'),bytes);
 const initial=fresh();assert.equal(initial.accepted,true);
 fs.renameSync(path.join(root,'.tmp'),path.join(root,'saved-workspace'));fs.mkdirSync(path.join(root,'.tmp'));
 const replacement=fresh();assert.equal(replacement.accepted,true);assert.notEqual(initial.pid,replacement.pid);assert.notEqual(initial.ino,replacement.ino);
 assert.deepEqual(fs.readFileSync(path.join(root,'saved-workspace','preserved-chunk')),bytes);
 report.restart={missingWorkspace:missing,initial,replacement,securityResult:'FAIL: new production process accepted substituted .tmp',originalFixturePreserved:true};
 process.env.NODE_ENV='production';process.env.STORAGE_PATH=root;
 storage=new StorageService(new ConfigService());resolver=new UploadWorkspaceResolver(storage);
 const ingress=resolver.ingress(LEGACY_UPLOAD_WORKSPACE);fs.mkdirSync(ingress);
 const outside=path.join(scratch,'outside');fs.mkdirSync(outside);
 let target;
 const engine=abortableDiskStorage(ingress,p=>{
   resolver.assertPath(p);target=p;
   fs.renameSync(ingress,path.join(root,'.tmp','saved-ingress'));fs.symlinkSync(outside,ingress);
 });
 const req=new EventEmitter();req.res=new EventEmitter();
 await new Promise((resolve,reject)=>engine._handleFile(req,{stream:Readable.from(bytes)},(error,file)=>error?reject(error):resolve(file)));
 assert.deepEqual(fs.readFileSync(path.join(outside,path.basename(target))),bytes);
 assert.deepEqual(fs.readdirSync(path.join(root,'.tmp','saved-ingress')),[]);
 report.ingress={actualMulterWriter:true,guard:'actual production resolver guard then deterministic ancestor swap',escapedFixtureBytes:bytes.length,securityResult:'FAIL: production ingress race unresolved'};
 report.checkpointStatus='BLOCKED';
})().then(()=>{
 resolver?.close();storage?.onModuleDestroy();
 fs.rmSync(scratch,{recursive:true,force:true});
 for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true});
 report.cleanup='private scratch and fixture tree removed; tmpfs destroyed with --rm';
 console.log('HCRESULT='+JSON.stringify(report));
}).catch(error=>{
 resolver?.close();storage?.onModuleDestroy();fs.rmSync(scratch,{recursive:true,force:true});
 console.error(error);process.exitCode=1;
});
