const fs=require('node:fs'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {Readable}=require('node:stream');
const {ConfigService}=require('/app/node_modules/@nestjs/config');
const {StorageService}=require('/app/dist/storage/storage.service');
const {UploadWorkspaceResolver,LEGACY_UPLOAD_WORKSPACE}=require('/app/dist/uploads/upload-workspace');
const {abortableDiskStorage}=require('/app/dist/uploads/abortable-disk-storage');
const {legacyBinding,markerContents,IDENTITY_MARKER}=require('/app/dist/storage/storage-mount-registry');
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.getuid(),1001);assert.equal(fs.existsSync('/storage'),false);
assert.deepEqual(fs.readdirSync('/qualified'),[]);process.env.NODE_ENV='production';process.env.STORAGE_PATH='/qualified';
fs.writeFileSync('/qualified/'+IDENTITY_MARKER,markerContents(legacyBinding('/qualified',true)),{mode:0o600});fs.mkdirSync('/qualified/.tmp');
let storage,resolver;
try{
 storage=new StorageService(new ConfigService());resolver=new UploadWorkspaceResolver(storage);
 assert.throws(()=>resolver.ingress(LEGACY_UPLOAD_WORKSPACE),e=>e.cause?.code==='ENOSYS');
 const req=new EventEmitter();req.res=new EventEmitter();let refused=false;
 abortableDiskStorage('/qualified/.tmp/multipart-ingress',p=>resolver.assertPath(p),()=>resolver.filesystem())._handleFile(req,{stream:Readable.from(Buffer.from([0,255,128,0,1]))},error=>{assert.ok(error);refused=true;});
 assert.equal(refused,true);assert.deepEqual(fs.readdirSync('/qualified/.tmp'),[]);
 console.log('HCRESULT='+JSON.stringify({platform:process.platform,architecture:process.arch,kernel:fs.readFileSync('/proc/sys/kernel/osrelease','utf8').trim(),uid:process.getuid(),runtime:'Docker Desktop amd64 emulation context',rootAcquisition:'ENOSYS',multer:'FAIL_CLOSED',uploadBytesWritten:0,ingressDirectoryCreated:false,fallback:false,cause:'NOT_ESTABLISHED',qualification:'BLOCKED'}));
}finally{resolver?.close();storage?.onModuleDestroy();}
