/* Disposable Docker process only. Backend source remains unchanged. */
'use strict';
require('reflect-metadata');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const express = require('express');
const {DataSource} = require('typeorm');
if (process.env.HOMECLOUD_BROWSER_FIXTURE !== '1' || process.platform !== 'linux' || process.getuid() !== 1001) throw Error('Disposable fixture opt-in and Linux uid 1001 required');
const originalUrl = new URL(process.env.DATABASE_URL);
if(originalUrl.hostname !== 'fixture-db' || originalUrl.pathname !== '/frontend_ssd_fixture') throw Error('Dedicated fixture DB required');
if(process.env.STORAGE_PATH !== '/storage' || process.env.UPLOAD_SSD_PATH !== '/ssd') throw Error('Exact owned storage roots required');
const schema = 'browser_' + randomUUID().replaceAll('-', '');
let app, admin;
let mode = process.env.FIXTURE_SSD === 'true';
const controls = {busy:0, busyStage:'complete', capacity:0, delayChunkMs:0, loseCompleteResponse:0};
const events = [];
const controlKey = process.env.FIXTURE_CONTROL_KEY;
function event(name,detail={}) {events.push({name,time:Date.now(),...detail});}
async function boot(){
 process.env.UPLOAD_SSD_ENABLED=String(mode);
 delete require.cache[require.resolve('/app/dist/app.module')];
 const {AppModule}=require('/app/dist/app.module');
 const {NestFactory}=require('@nestjs/core');
 const {ValidationPipe}=require('@nestjs/common');
 const {ConfigService}=require('@nestjs/config');
 const {JwtService}=require('@nestjs/jwt');
 const {HttpExceptionFilter}=require('/app/dist/common/errors/http-exception.filter');
 const {TransformInterceptor}=require('/app/dist/common/interceptors/transform.interceptor');
 const {structuredLogger}=require('/app/dist/common/observability/structured-logger');
 const {requestObservability}=require('/app/dist/common/observability/request-observability');
 const {MetricsService}=require('/app/dist/common/observability/metrics.service');
 const {applySecurityMiddleware}=require('/app/dist/common/security.config');
 const {configureTrustedProxy}=require('/app/dist/common/trusted-proxy');
 const {validateStartupConfiguration}=require('/app/dist/common/startup-validation.service');
 const {UploadRateLimitService}=require('/app/dist/uploads/upload-rate-limit');
 app=await NestFactory.create(AppModule,{logger:structuredLogger,bodyParser:false,abortOnError:false});
 await validateStartupConfiguration(app);
 const config=app.get(ConfigService);assert.equal(String(config.get('UPLOAD_SSD_ENABLED')),String(mode));
 configureTrustedProxy(app,config);app.use(requestObservability(app.get(MetricsService)));
 applySecurityMiddleware(app,config,{jwtService:app.get(JwtService),uploads:app.get(UploadRateLimitService)});
 app.useBodyParser('json');app.useBodyParser('urlencoded',{extended:true});
 const query=(sql,args=[])=>app.get(DataSource).query(sql,args);
 assert.equal((await query('select current_schema() schema'))[0].schema,schema);
 app.use(async(req,res,next)=>{
  if(req.path.startsWith('/__fixture')){
   if(req.get('x-fixture-control')!==controlKey)return res.status(403).end();
   try{
    if(req.path==='/__fixture/control' && req.method==='POST'){Object.assign(controls,req.body);return res.json({mode,controls});}
    if(req.path==='/__fixture/state')return res.json({schema,mode,controls,events,sessions:await query('SELECT "uploadId",filename,"expectedSha256","workspaceId",status,"uploadedCount","totalChunks" FROM upload_sessions ORDER BY id'),files:await query('SELECT id,name,size,"storagePath" as path,"relativeObjectKey","storageLocationId","uploadId" FROM files ORDER BY id'),receipts:await query('SELECT "uploadId",state,"cleanupState" FROM ssd_finalization_operations')});
    if(req.path==='/__fixture/quota' && req.method==='POST'){await query('UPDATE users SET "storageQuota"=1073741824 WHERE email=$1',[req.body.email]);return res.json({ok:true});}
    return res.status(404).end();
   }catch(error){return res.status(500).json({message:error.message});}
  }
  if(req.path.startsWith('/api/v1/uploads')){
   event('request',{method:req.method,path:req.path});
   if(req.method==='POST' && req.path==='/api/v1/uploads/session') event('admission',{filename:req.body.filename,totalSize:req.body.totalSize,expectedSha256:req.body.expectedSha256});
   const busyRoute=controls.busyStage==='admission'?req.path==='/api/v1/uploads/session':req.path.endsWith('/complete');
   if(req.method==='POST' && busyRoute && controls.busy>0){controls.busy--;event('injected-busy503');res.set('Retry-After','1');return res.status(503).json({statusCode:503,message:'SSD finalization is busy',error:'Service Unavailable'});}
   if(req.method==='POST' && req.path==='/api/v1/uploads/session' && controls.capacity>0){controls.capacity--;event('injected-capacity503');return res.status(503).json({statusCode:503,message:'Insufficient SSD or HDD capacity',error:'Service Unavailable'});}
   if(req.path.endsWith('/chunk') && controls.delayChunkMs)await new Promise(done=>setTimeout(done,Math.min(controls.delayChunkMs,2000)));
  }
  next();
 });
 const staticApp=app.getHttpAdapter().getInstance();
 const candidateStatic=express.static('/candidate-dist'),baselineStatic=express.static('/baseline-dist');
 const baselineRequest=req=>(req.headers.cookie||'').split(';').some(part=>part.trim()==='hcFixtureFrontend=baseline');
 staticApp.use((req,res,next)=>(baselineRequest(req)?baselineStatic:candidateStatic)(req,res,next));
 staticApp.get(/^\/(?!api\/|__fixture).*/, (req,res)=>res.sendFile(baselineRequest(req)?'/baseline-dist/index.html':'/candidate-dist/index.html'));
 app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
 app.useGlobalFilters(new HttpExceptionFilter());app.useGlobalInterceptors(new TransformInterceptor());app.setGlobalPrefix('api/v1');
 const {PostgresSsdFinalizationStore}=require('/app/dist/uploads/ssd-finalization-store');
 const store=app.get(PostgresSsdFinalizationStore),commit=store.commit.bind(store);
 store.commit=async(id)=>{const value=await commit(id);if(controls.loseCompleteResponse>0){controls.loseCompleteResponse--;event('injected-postcommit-http500');throw Error('Fixture durable response loss');}return value;};
 await app.listen(3000,'0.0.0.0');event('boot',{mode});
 fs.writeFileSync('/tmp/browser-ready.json',JSON.stringify({ready:true,schema,mode,devices:{hdd:String(fs.statSync('/storage').dev),ssd:String(fs.statSync('/ssd').dev)}}));
}
(async()=>{
 process.env.NODE_ENV='test';process.env.DB_PASSWORD=decodeURIComponent(originalUrl.password);
 process.env.REDIS_PASSWORD=randomBytes(24).toString('hex');process.env.JWT_SECRET=randomBytes(32).toString('hex');process.env.JWT_REFRESH_SECRET=randomBytes(32).toString('hex');
 process.env.MAX_CHUNK_SIZE='1048576';process.env.MAX_FILE_SIZE='67108864';process.env.MAX_TOTAL_SIZE='268435456';
 const mountLine=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').find(l=>l.split(' ')[4]==='/ssd');if(!mountLine)throw Error('Owned SSD mount missing');
 const fields=mountLine.split(' '),split=fields.indexOf('-');process.env.UPLOAD_SSD_MOUNT_SOURCE=fields[split+2];process.env.UPLOAD_SSD_MOUNT_ROOT=fields[3];process.env.UPLOAD_SSD_FS_TYPE=fields[split+1];
 const {markerContents}=require('/app/dist/storage/storage-mount-registry');const {SSD_UPLOAD_WORKSPACE}=require('/app/dist/entities/upload-workspace.entity');
 const marker='/ssd/.homecloud-storage-identity',expected=markerContents(SSD_UPLOAD_WORKSPACE);if(!fs.existsSync(marker))fs.writeFileSync(marker,expected,{flag:'wx',mode:0o600});assert.equal(fs.readFileSync(marker,'utf8'),expected);fs.mkdirSync('/storage/.tmp',{recursive:true,mode:0o700});
 assert.notEqual(fs.statSync('/storage').dev,fs.statSync('/ssd').dev);
 admin=new DataSource({type:'postgres',url:originalUrl.toString()});await admin.initialize();await admin.query(`CREATE SCHEMA "${schema}"`);
 const fixtureUrl=new URL(originalUrl);fixtureUrl.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=fixtureUrl.toString();
 const migrations=require('/app/dist/data-source').default;migrations.setOptions({schema,extra:{options:`-c search_path=${schema}`}});await migrations.initialize();await migrations.runMigrations();await migrations.destroy();
 await boot();
})().catch(error=>{console.error('Fixture failure:',error.message);process.exitCode=1;});
