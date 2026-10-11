// Actual compiled UploadsService in two processes, isolated PostgreSQL schema + tmpfs.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const {randomUUID,createHash}=require('node:crypto');
const {DataSource}=require('/app/node_modules/typeorm');
const {ConfigService,ConfigModule}=require('/app/node_modules/@nestjs/config');
const {Module}=require('/app/node_modules/@nestjs/common');
const {NestFactory}=require('/app/node_modules/@nestjs/core');
const classes={};for(const [stem,name] of [['storage-location','StorageLocation'],['user','User'],['file','File'],['folder','Folder'],['share-link','ShareLink'],['upload-workspace','UploadWorkspace'],['upload-session','UploadSession'],['upload-chunk','UploadChunk'],['refresh-token','RefreshToken']])classes[name]=require('/app/dist/entities/'+stem+'.entity')[name+'Entity'];
const {LEGACY_STORAGE_LOCATION}=require('/app/dist/entities/storage-location.entity');const {LEGACY_UPLOAD_WORKSPACE}=require('/app/dist/entities/upload-workspace.entity');
const {StorageService}=require('/app/dist/storage/storage.service');const {StorageModule}=require('/app/dist/storage/storage.module');
const {UploadsModule}=require('/app/dist/uploads/uploads.module');const {UploadsService}=require('/app/dist/uploads/uploads.service');const {UsersService}=require('/app/dist/users/users.service');
const {legacyBinding,markerContents,IDENTITY_MARKER}=require('/app/dist/storage/storage-mount-registry');
assert.equal(process.getuid(),1000);assert.equal(fs.existsSync('/storage'),false);
const root='/qualified',schema=process.env.HC_RECOVERY_SCHEMA||'uploads_bigint_'+randomUUID().replaceAll('-','');
const config=new ConfigService({STORAGE_PATH:root,NODE_ENV:'production',MAX_FILE_SIZE:1024,MAX_TOTAL_SIZE:1024,MAX_CHUNK_SIZE:4});
const options={type:'postgres',url:process.env.HOMECLOUD_TEST_DATABASE_URL,schema,entities:Object.values(classes),synchronize:false,extra:{options:'-c search_path='+schema}};
function service(source){const storage=new StorageService(config);const uploads=new UploadsService(source.getRepository(classes.UploadSession),source.getRepository(classes.File),source.getRepository(classes.Folder),storage,new UsersService(source.getRepository(classes.User)),config);return {storage,uploads};}
(async()=>{
 if(process.env.HC_RECOVERY_CHILD){
  const db=new DataSource(options);await db.initialize();const s=service(db);const sync=s.uploads.syncDirectory.bind(s.uploads);
  s.uploads.syncDirectory=async p=>{await sync(p);process.send({state:'published_and_synced'});await new Promise(()=>{});};
  await s.uploads.uploadChunk(Number(process.env.HC_RECOVERY_USER),process.env.HC_RECOVERY_UPLOAD,0,Buffer.from('data'));
  throw new Error('child must never reach DB metadata commit');
 }
 assert.deepEqual(fs.readdirSync(root),[]);fs.writeFileSync(root+'/'+IDENTITY_MARKER,markerContents(legacyBinding(root,true)),{mode:0o600});fs.mkdirSync(root+'/.tmp');
 const admin=new DataSource({type:'postgres',url:options.url});await admin.initialize();let db,initial,resumed,child;
 try{
  await admin.query('CREATE SCHEMA "'+schema+'"');db=new DataSource({...options,synchronize:true});await db.initialize();
  await db.getRepository(classes.StorageLocation).save(LEGACY_STORAGE_LOCATION);await db.getRepository(classes.UploadWorkspace).save(LEGACY_UPLOAD_WORKSPACE);
  const user=await db.getRepository(classes.User).save({email:randomUUID()+'@example.test',password:'fixture',name:'fixture',storageQuota:1024,storageUsed:0});
  initial=service(db);const session=await initial.uploads.createUploadSession(user.id,'crash.bin',4,4);
  child=spawn(process.execPath,[__filename],{env:{...process.env,HC_RECOVERY_CHILD:'1',HC_RECOVERY_SCHEMA:schema,HC_RECOVERY_USER:String(user.id),HC_RECOVERY_UPLOAD:session.uploadId},stdio:['ignore','ignore','inherit','ipc']});
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('crash fixture timeout'));},15000);child.once('error',reject);child.once('message',m=>{assert.equal(m.state,'published_and_synced');child.kill('SIGKILL');});child.once('exit',(_code,signal)=>{clearTimeout(deadline);signal==='SIGKILL'?resolve():reject(new Error('unexpected child exit'));});});
  const file=session.tempPath+'/0',inode=fs.statSync(file).ino;assert.equal(fs.readFileSync(file,'utf8'),'data');
  assert.equal(await db.getRepository(classes.UploadChunk).count(),0);const afterCrash=await db.getRepository(classes.UploadSession).findOneByOrFail({id:session.id});assert.equal(afterCrash.uploadedCount,0);assert.equal(afterCrash.uploadedSize,0);
  await initial.uploads.onModuleDestroy();initial.storage.onModuleDestroy();initial=undefined;
  resumed=service(db);await resumed.uploads.cleanupOrphanedTempDirs();assert.equal(fs.statSync(file).ino,inode);
  await resumed.uploads.uploadChunk(user.id,session.uploadId,0,Buffer.from('data'));await resumed.uploads.uploadChunk(user.id,session.uploadId,0,Buffer.from('data'));
  const restored=await db.getRepository(classes.UploadSession).findOneByOrFail({id:session.id});assert.equal(restored.uploadedCount,1);assert.equal(restored.uploadedSize,4);assert.equal(fs.statSync(file).ino,inode);
  const completed=await resumed.uploads.completeUpload(user.id,session.uploadId);assert.equal(fs.readFileSync(completed.storagePath,'utf8'),'data');assert.equal(Number((await db.getRepository(classes.User).findOneByOrFail({id:user.id})).storageUsed),4);
  await resumed.uploads.onModuleDestroy();resumed.storage.onModuleDestroy();resumed=undefined;
  // Exercise actual production Multer useClass DI and its shutdown hook.
  process.env.STORAGE_PATH=root;process.env.NODE_ENV='production';
  const multer=Reflect.getMetadata('imports',UploadsModule).find(x=>x.module?.name==='MulterModule');assert.ok(multer);
  class Fixture{};Module({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),StorageModule,multer]})(Fixture);
  const fds=()=>fs.readdirSync('/proc/self/fd').length,baseline=fds();const app=await NestFactory.createApplicationContext(Fixture,{logger:false});await app.close();assert.equal(fds(),baseline);
  console.log('HCRESULT='+JSON.stringify({architecture:process.arch,kernel:fs.readFileSync('/proc/sys/kernel/osrelease','utf8').trim(),uid:process.getuid(),scope:'actual compiled UploadsService; SIGKILL in child after chunk publication+directory fsync before PostgreSQL metadata commit; isolated schema/persistent ext4',crash:'SIGKILL',orphanBytesRetained:true,originalInodeRetained:true,metadataRolledBack:true,retryIdempotent:true,uploadedCount:1,uploadedSize:4,quotaCharged:4,sha256:createHash('sha256').update(fs.readFileSync(completed.storagePath)).digest('hex'),multerFactoryLifecycle:'PASS/no FD leak',powerLoss:'UNQUALIFIED'}));
 }finally{if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');for(const s of [initial,resumed])if(s){await s.uploads.onModuleDestroy();s.storage.onModuleDestroy();}if(db?.isInitialized)await db.destroy();await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await admin.destroy();}
})().catch(e=>{console.error('Recovery fixture failed: '+e.message);process.exitCode=1;});
