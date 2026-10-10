const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {Client}=require('pg');
const sharp=require('sharp');
const origin='http://127.0.0.1:3000/api/v1';
const client=new Client({connectionString:process.env.DATABASE_URL});
let token,user,folder,existedUserDir=true;
const createdFiles=new Set(),activeSessions=new Set();
const checks=[];
async function call(method,path,body,expected=200,auth=true,extra={}){
 const headers={...extra};if(auth&&token)headers.Authorization='Bearer '+token;
 if(body!==undefined&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
 const res=await fetch(origin+path,{method,headers,body,signal:AbortSignal.timeout(15000)});
 const bytes=Buffer.from(await res.arrayBuffer());
 assert.equal(res.status,expected,method+' '+path+' status '+res.status+' '+(res.status!==expected?bytes.toString().slice(0,300):''));
 let value;try{value=JSON.parse(bytes);value=value.data??value;}catch{}
 return {res,bytes,value};
}
async function upload(name,bytes,parentId){
 const admission=(await call('GET','/uploads/limits')).value;
 const session=(await call('POST','/uploads/session',{filename:name,totalSize:bytes.length,chunkSize:bytes.length,parentId},201)).value;
 activeSessions.add(session.uploadId);
 const reserved=(await call('GET','/uploads/limits')).value;
 assert.equal(Number(reserved.quotaRemainingBytes),Number(admission.quotaRemainingBytes)-bytes.length);
 const form=new FormData();form.append('chunkIndex','0');form.append('chunk',new Blob([bytes]),name);
 await call('POST','/uploads/session/'+session.uploadId+'/chunk',form);
 const file=(await call('POST','/uploads/session/'+session.uploadId+'/complete')).value;
 activeSessions.delete(session.uploadId);createdFiles.add(file.id);
 assert.equal(file.storageLocationId,'f2f5c4b0-8d57-4c49-9f8c-0d095b344601');
 assert.equal(file.storagePath,'/storage/'+file.relativeObjectKey);
 assert.deepEqual((await call('GET','/files/'+file.id+'/download')).bytes,bytes);
 const retry=(await call('POST','/uploads/session/'+session.uploadId+'/complete')).value;
 assert.equal(retry.id,file.id);
 return file;
}
function unzip(bytes){
 const end=bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert(end>=0);
 let at=bytes.readUInt32LE(end+16);const result=new Map();
 for(let i=0;i<bytes.readUInt16LE(end+10);i++){
  assert.equal(bytes.readUInt32LE(at),0x02014b50);
  const method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+20),n=bytes.readUInt16LE(at+28),x=bytes.readUInt16LE(at+30),c=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
  const name=bytes.subarray(at+46,at+46+n).toString('utf8');
  const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
  const data=bytes.subarray(start,start+size);
  result.set(name,method===8?zlib.inflateRawSync(data):data);at+=46+n+x+c;
 }
 return result;
}
(async()=>{
 await client.connect();
 try{
  const email='workspace-smoke-'+crypto.randomUUID()+'@example.test';
  const password=crypto.randomBytes(24).toString('hex');
  token=(await call('POST','/auth/register',{email,password,name:'Workspace checkpoint smoke'},201,false)).value.accessToken;
  user=(await call('GET','/users/me')).value;
  assert.equal(user.email,email);existedUserDir=fs.existsSync('/storage/'+user.id);
  const quota=await client.query('UPDATE users SET "storageQuota"=1048576 WHERE id=$1 AND email=$2',[user.id,email]);assert.equal(quota.rowCount,1);
  const limitsBefore=(await call('GET','/uploads/limits')).value;
  const bound=(await call('POST','/uploads/session',{filename:'resume.bin',totalSize:4,chunkSize:2},201)).value;
  activeSessions.add(bound.uploadId);
  const binding=(await client.query('SELECT id,"workspaceId","tempPath" FROM upload_sessions WHERE "uploadId"=$1 AND "userId"=$2',[bound.uploadId,user.id])).rows[0];
  assert.equal(binding.workspaceId,'87798389-88af-4ea5-a3e7-8e69a3c7bb01');assert.equal(binding.tempPath,'/storage/.tmp/'+bound.uploadId);
  const sendPart=async(index,bytes)=>{const form=new FormData();form.append('chunkIndex',String(index));form.append('chunk',new Blob([bytes]),'resume.bin');return call('POST','/uploads/session/'+bound.uploadId+'/chunk',form)};
  await sendPart(0,Buffer.from('ab'));
  const paused=(await call('GET','/uploads/session/'+bound.uploadId)).value;
  assert.equal(paused.chunks.length,1);assert.equal(paused.uploadedSize,2);
  const reserved=(await call('GET','/uploads/limits')).value;assert.equal(reserved.quotaRemainingBytes,limitsBefore.quotaRemainingBytes-4);
  // Concurrent idempotent retries exercise the real HTTP429 admission gate.
  const burst=await Promise.all(Array.from({length:12},async()=>{
   const form=new FormData();form.append('chunkIndex','0');form.append('chunk',new Blob([Buffer.from('ab')]),'resume.bin');
   const res=await fetch(origin+'/uploads/session/'+bound.uploadId+'/chunk',{method:'POST',headers:{Authorization:'Bearer '+token},body:form,signal:AbortSignal.timeout(15000)});
   await res.arrayBuffer();assert([200,429].includes(res.status));
   if(res.status===429)assert(Number(res.headers.get('Retry-After'))>=1);return res.status;
  }));assert(burst.includes(429));
  token=(await call('POST','/auth/login',{email,password},200,false)).value.accessToken;
  const reload=(await call('GET','/uploads/session/'+bound.uploadId)).value;
  assert.deepEqual(reload.chunks,paused.chunks);assert.equal((await call('GET','/uploads/limits')).value.quotaRemainingBytes,reserved.quotaRemainingBytes);
  assert((await call('GET','/uploads/sessions')).value.some(session=>session.uploadId===bound.uploadId));
  await sendPart(1,Buffer.from('cd'));
  const resumed=(await call('POST','/uploads/session/'+bound.uploadId+'/complete')).value;
  activeSessions.delete(bound.uploadId);createdFiles.add(resumed.id);
  assert.deepEqual((await call('GET','/files/'+resumed.id+'/download')).bytes,Buffer.from('abcd'));
  assert.equal((await client.query('SELECT id FROM upload_sessions WHERE "uploadId"=$1',[bound.uploadId])).rows[0].id,binding.id);
  assert(!fs.existsSync(binding.tempPath));
  await call('DELETE','/files/'+resumed.id+'/permanent');createdFiles.delete(resumed.id);
  assert.equal((await call('GET','/uploads/limits')).value.quotaRemainingBytes,limitsBefore.quotaRemainingBytes);
  await call('POST','/uploads/session',{filename:'quota-block.bin',totalSize:1048577,chunkSize:1048577},403);
  const cancel=(await call('POST','/uploads/session',{filename:'cancel.bin',totalSize:2,chunkSize:2},201)).value;
  activeSessions.add(cancel.uploadId);await call('DELETE','/uploads/session/'+cancel.uploadId);activeSessions.delete(cancel.uploadId);
  assert(!fs.existsSync('/storage/.tmp/'+cancel.uploadId));
  checks.push('immutable workspace binding + partial pause + fresh-auth reload + resume/finalize + controlled HTTP429 Retry-After + quota reservations/cancel');
  const expired=(await call('POST','/uploads/session',{filename:'expiry.bin',totalSize:2,chunkSize:2},201)).value;activeSessions.add(expired.uploadId);
  await client.query(`UPDATE upload_sessions SET "expiresAt"=now()-interval '1 minute' WHERE "uploadId"=$1 AND "userId"=$2`,[expired.uploadId,user.id]);
  const dataSource=require('/app/dist/data-source.js').default;await dataSource.initialize();
  const {ConfigService}=require('@nestjs/config'),{StorageService}=require('/app/dist/storage/storage.service.js'),{UploadsService}=require('/app/dist/uploads/uploads.service.js'),{UsersService}=require('/app/dist/users/users.service.js');
  const {UploadSessionEntity}=require('/app/dist/entities/upload-session.entity.js'),{FileEntity}=require('/app/dist/entities/file.entity.js'),{FolderEntity}=require('/app/dist/entities/folder.entity.js'),{UserEntity}=require('/app/dist/entities/user.entity.js');
  const config=new ConfigService(process.env),storage=new StorageService(config);
  const recovery=new UploadsService(dataSource.getRepository(UploadSessionEntity),dataSource.getRepository(FileEntity),dataSource.getRepository(FolderEntity),storage,new UsersService(dataSource.getRepository(UserEntity)),config);
  try{
   assert.equal(await recovery.cleanupExpiredSessions(),1);activeSessions.delete(expired.uploadId);
   assert(!fs.existsSync('/storage/.tmp/'+expired.uploadId));
   const orphan='/storage/.tmp/'+crypto.randomUUID();fs.mkdirSync(orphan);fs.writeFileSync(orphan+'/0','orphan');
   assert.equal(await recovery.cleanupOrphanedTempDirs(),1);assert(!fs.existsSync(orphan));
  }finally{await recovery.onModuleDestroy();storage.onModuleDestroy();await dataSource.destroy();}
  assert.equal((await call('GET','/uploads/limits')).value.quotaRemainingBytes,limitsBefore.quotaRemainingBytes);
  checks.push('real PostgreSQL expiry + startup orphan recovery/cleanup + quota reservation release');
  folder=(await call('POST','/files/folders',{name:'Runtime fixture folder'},201)).value;
  const text=Buffer.from('logical placement runtime\n'),binary=Buffer.from([0,255,128,77,90,0,13,10]);
  const png=await sharp({create:{width:2,height:2,channels:4,background:{r:15,g:80,b:160,alpha:1}}}).png().toBuffer();
  const normal=await upload('normal.txt',text,folder.folderId);
  const arbitrary=await upload('arbitrary.odd',binary,folder.folderId);
  const image=await upload('image.png',png,folder.folderId);
  checks.push('normal/binary/image upload + reservation + finalize retry + logical pair + download bytes');
  assert.deepEqual((await call('GET','/files/'+arbitrary.id+'/download',undefined,206,true,{Range:'bytes=1-3'})).bytes,binary.subarray(1,4));
  const prepared=await call('POST','/native-downloads/'+arbitrary.id+'/prepare',{});
  const cookie=prepared.res.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await call('GET',prepared.value.downloadPath.replace(/^\/api\/v1/,''),undefined,200,false,{Cookie:cookie})).bytes,binary);
  checks.push('owner Range + native capability download');
  const shared=(await call('POST','/sharing',{fileId:image.id,expiresInDays:1},201)).value;
  assert.deepEqual((await call('POST','/sharing/public/'+shared.token+'/download',{},200,false)).bytes,png);
  const original={storageLocationId:normal.storageLocationId,relativeObjectKey:normal.relativeObjectKey,storagePath:normal.storagePath};
  await call('PATCH','/files/'+normal.id,{name:'renamed.txt'});
  await call('POST','/files/'+normal.id+'/move',{});
  await call('POST','/files/'+normal.id+'/move',{targetParentId:folder.folderId});
  const renamed=(await call('GET','/files/'+normal.id)).value;
  for(const key of Object.keys(original))assert.equal(renamed[key],original[key]);
  const total=text.length+binary.length+png.length;
  assert.equal(Number((await call('GET','/files/storage-info')).value.storageUsed),total);
  await call('DELETE','/files/'+arbitrary.id);
  assert.equal(Number((await call('GET','/files/storage-info')).value.storageUsed),total);
  await call('POST','/files/'+arbitrary.id+'/restore',{});
  const copy=(await call('POST','/files/'+normal.id+'/copy',{},201)).value;createdFiles.add(copy.id);
  assert.equal(copy.storageLocationId,normal.storageLocationId);assert.notEqual(copy.relativeObjectKey,normal.relativeObjectKey);
  assert.deepEqual((await call('GET','/files/'+copy.id+'/download')).bytes,text);
  assert.equal(Number((await call('GET','/files/storage-info')).value.storageUsed),total+text.length);
  await call('DELETE','/files/'+copy.id+'/permanent');createdFiles.delete(copy.id);
  assert(!fs.existsSync(copy.storagePath));assert.equal(Number((await call('GET','/files/storage-info')).value.storageUsed),total);
  const folderShare=(await call('POST','/sharing',{fileId:folder.id,isFolder:true,expiresInDays:1},201)).value;
  const archive=(await call('POST','/sharing/public/'+folderShare.token+'/download',{},200,false)).bytes;
  const members=unzip(archive);
  for(const [name,bytes]of [['renamed.txt',text],['arbitrary.odd',binary],['image.png',png]]){
   const match=[...members].find(([entry])=>entry===name||entry.endsWith('/'+name));assert(match,'ZIP member missing');assert.deepEqual(match[1],bytes);
  }
  checks.push('public share + ZIP exact members');
  assert.equal((await call('GET','/previews/'+normal.id)).value.content,text.toString());
  const thumbnail=(await call('GET','/previews/'+image.id+'/thumbnail')).bytes;
  assert.deepEqual(thumbnail.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  checks.push('text preview + actual sharp thumbnail');
  checks.push('rename/move/trash/restore/copy/permanent delete + quota invariants');
 }finally{
  for(const id of activeSessions)await call('DELETE','/uploads/session/'+id,undefined,200);
  for(const id of createdFiles)await call('DELETE','/files/'+id+'/permanent');
  if(folder)await call('DELETE','/files/folders/'+folder.folderId+'/permanent');
  if(user){
   assert.equal(Number((await call('GET','/files/storage-info')).value.storageUsed),0);
   assert.equal(Number((await client.query('SELECT count(*) FROM files WHERE "userId"=$1',[user.id])).rows[0].count),0);
   await client.query('DELETE FROM users WHERE id=$1 AND email=$2',[user.id,user.email]);
   if(!existedUserDir&&fs.existsSync('/storage/'+user.id))fs.rmdirSync('/storage/'+user.id);
  }
  await client.end();
 }
 console.log(JSON.stringify({status:'PASS',checks,fixtureCleanup:'PASS',largeFileTest:'NOT_RUN'}));
})().catch(error=>{console.error('Runtime smoke failed:',error.message);process.exit(1)});
