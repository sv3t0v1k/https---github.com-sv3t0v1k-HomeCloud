// Test-only HTTP transport + actual compiled production factory/service; isolated PG.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const express = require('/app/node_modules/express');
const multer = require('/app/node_modules/multer');
const {DataSource} = require('/app/node_modules/typeorm');
const {ConfigService, ConfigModule} = require('/app/node_modules/@nestjs/config');
const {Module} = require('/app/node_modules/@nestjs/common');
const {NestFactory} = require('/app/node_modules/@nestjs/core');
const {MULTER_MODULE_OPTIONS} = require('/app/node_modules/@nestjs/platform-express/multer/files.constants');
const classes = {};
for (const [stem, name] of [['storage-location','StorageLocation'],['user','User'],['file','File'],['folder','Folder'],['share-link','ShareLink'],['upload-workspace','UploadWorkspace'],['upload-session','UploadSession'],['upload-chunk','UploadChunk'],['refresh-token','RefreshToken']]) {
  classes[name] = require('/app/dist/entities/'+stem+'.entity')[name+'Entity'];
}
const {LEGACY_STORAGE_LOCATION} = require('/app/dist/entities/storage-location.entity');
const {LEGACY_UPLOAD_WORKSPACE} = require('/app/dist/entities/upload-workspace.entity');
const {StorageService} = require('/app/dist/storage/storage.service');
const {StorageModule} = require('/app/dist/storage/storage.module');
const {UploadsService} = require('/app/dist/uploads/uploads.service');
const {UploadsModule} = require('/app/dist/uploads/uploads.module');
const {UsersService} = require('/app/dist/users/users.service');
const {legacyBinding, markerContents, IDENTITY_MARKER} = require('/app/dist/storage/storage-mount-registry');
const root = '/qualified', schema = 'http_r1q_'+randomUUID().replaceAll('-','');
const bytes = Buffer.from([0,255,128,0,1]);
assert.equal(process.getuid(),1000);
assert.equal(process.arch,'x64');
assert.equal(fs.existsSync('/storage'),false);
assert.deepEqual(fs.readdirSync(root),[]);
assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\s+0000000000000000/);
process.env.NODE_ENV='production';process.env.STORAGE_PATH=root;process.env.MAX_CHUNK_SIZE='5';
fs.writeFileSync(root+'/'+IDENTITY_MARKER,markerContents(legacyBinding(root,true)),{mode:0o600});
fs.mkdirSync(root+'/.tmp');
const url=process.env.HOMECLOUD_TEST_DATABASE_URL;
const admin=new DataSource({type:'postgres',url});
let db, storage, uploads, nest, server, created=false, result;
(async()=>{
  await admin.initialize();await admin.query('CREATE SCHEMA "'+schema+'"');created=true;
  db=new DataSource({type:'postgres',url,schema,entities:Object.values(classes),synchronize:true,extra:{options:'-c search_path='+schema}});
  await db.initialize();
  await db.getRepository(classes.StorageLocation).save(LEGACY_STORAGE_LOCATION);
  await db.getRepository(classes.UploadWorkspace).save(LEGACY_UPLOAD_WORKSPACE);
  const user=await db.getRepository(classes.User).save({email:randomUUID()+'@example.test',password:'fixture',name:'fixture',storageQuota:1024,storageUsed:0});
  const config=new ConfigService({STORAGE_PATH:root,NODE_ENV:'production',MAX_FILE_SIZE:1024,MAX_TOTAL_SIZE:1024,MAX_CHUNK_SIZE:5});
  storage=new StorageService(config);
  uploads=new UploadsService(db.getRepository(classes.UploadSession),db.getRepository(classes.File),db.getRepository(classes.Folder),storage,new UsersService(db.getRepository(classes.User)),config);
  const registration=Reflect.getMetadata('imports',UploadsModule).find(x=>x.module?.name==='MulterModule');
  assert.ok(registration);
  class Fixture {}
  Module({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),StorageModule,registration]})(Fixture);
  nest=await NestFactory.createApplicationContext(Fixture,{logger:false});
  const options=nest.get(MULTER_MODULE_OPTIONS);
  assert.ok(options.storage);
  const app=express();
  app.post('/chunk/:uploadId',multer(options).single('chunk'),async(req,res,next)=>{
    try {
      assert.ok(req.file);assert.equal(req.ingressWritePending,false);
      const session=await uploads.uploadChunk(user.id,req.params.uploadId,0,{path:req.file.path,size:req.file.size});
      res.json({uploadedCount:session.uploadedCount,uploadedSize:session.uploadedSize});
    }catch(error){next(error);}
  });
  app.use((error,_req,res,_next)=>res.status(400).json({code:error.code||'REFUSED'}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  async function post(uploadId,data){
    const form=new FormData();form.append('chunk',new Blob([data]),'chunk.bin');
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/chunk/'+uploadId,{method:'POST',body:form,signal:AbortSignal.timeout(15000)});
    return {status:response.status,body:await response.json()};
  }
  const session=await uploads.createUploadSession(user.id,'http.bin',5,5);
  for(let attempt=0;attempt<2;attempt++){
    const result=await post(session.uploadId,bytes);assert.equal(result.status,200);assert.deepEqual(result.body,{uploadedCount:1,uploadedSize:5});
    assert.deepEqual(fs.readdirSync(root+'/.tmp/multipart-ingress'),[]);
  }
  assert.equal(await db.getRepository(classes.UploadChunk).count(),1);
  const completed=await uploads.completeUpload(user.id,session.uploadId);
  assert.deepEqual(fs.readFileSync(completed.storagePath),bytes);
  assert.equal(Number((await db.getRepository(classes.User).findOneByOrFail({id:user.id})).storageUsed),5);
  assert.equal(await db.getRepository(classes.UploadChunk).count(),0);
  const cancelled=await uploads.createUploadSession(user.id,'cancel.bin',5,5);
  assert.equal((await post(cancelled.uploadId,bytes)).status,200);
  await uploads.abortUpload(user.id,cancelled.uploadId);
  assert.equal(fs.existsSync(cancelled.tempPath),false);
  assert.equal(await db.getRepository(classes.UploadChunk).count(),0);
  assert.equal(Number((await db.getRepository(classes.User).findOneByOrFail({id:user.id})).storageUsed),5);
  assert.deepEqual(fs.readdirSync(root+'/.tmp/multipart-ingress'),[]);
  result={architecture:process.arch,uid:process.getuid(),transport:'actual multipart HTTP on container loopback; production Multer useClass factory/options unmodified',scope:'actual UploadsService ingress→chunk→finalizer; own PG schema and disposable ext4; authentication/controller pipeline not exercised',bytes:5,successfulRequests:3,retryIdempotent:true,ingressCleanup:true,exactFinalBytes:true,quotaCharged:5,cancelCleanup:true,sha256:createHash('sha256').update(bytes).digest('hex'),result:'PASS'};
})().catch(error=>{console.error('HTTP fixture failed: '+error.message);process.exitCode=1;}).finally(async()=>{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(nest)await nest.close();
  if(uploads)await uploads.onModuleDestroy();
  if(storage)storage.onModuleDestroy();
  if(db?.isInitialized)await db.destroy();
  if(admin.isInitialized){if(created)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.destroy();}
}).then(()=>{if(result && !process.exitCode)console.log('HCRESULT='+JSON.stringify(result));}).catch(error=>{console.error('HTTP cleanup failed: '+error.message);process.exitCode=1;});
