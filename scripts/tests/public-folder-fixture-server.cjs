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
const mode = process.env.FIXTURE_SSD === 'true';
const controls = {};
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
 applySecurityMiddleware(app,config,{jwtService:app.get(JwtService),uploads:app.get(UploadRateLimitService),publicUploads:app.get(require('/app/dist/sharing/public-uploads.service').PublicUploadsService)});
 app.useBodyParser('json');app.useBodyParser('urlencoded',{extended:true});
 const query=(sql,args=[])=>app.get(DataSource).query(sql,args);
 assert.equal((await query('select current_schema() schema'))[0].schema,schema);
 app.use(async(req,res,next)=>{
  if(req.path.startsWith('/__fixture')){
   if(req.get('x-fixture-control')!==controlKey)return res.status(403).end();
   try{
    if(req.path==='/__fixture/control' && req.method==='POST'){Object.assign(controls,req.body);return res.json({mode,controls});}
    if(req.path==='/__fixture/state')return res.json({schema,mode,controls,events,sessions:await query('SELECT "uploadId",filename,"expectedSha256","workspaceId",status,"uploadedCount","totalChunks" FROM upload_sessions ORDER BY id'),folders:await query('SELECT id,name,"parentId" FROM folders ORDER BY id'),files:await query('SELECT id,name,size,"parentId","folderId",checksum,"storagePath" as path,"relativeObjectKey","storageLocationId","uploadId" FROM files ORDER BY id'),receipts:await query('SELECT "uploadId",state,"cleanupState" FROM ssd_finalization_operations')});
    if(req.path==='/__fixture/quota' && req.method==='POST'){const bytes=req.body.bytes??1073741824;assert.ok(Number.isSafeInteger(bytes)&&bytes>=0);await query('UPDATE users SET \"storageQuota\"=$2 WHERE email=$1',[req.body.email,bytes]);return res.json({ok:true});}
    if(req.path==='/__fixture/share' && req.method==='POST'){assert.ok(Number.isSafeInteger(req.body.id));if(req.body.expire)await query('UPDATE share_links SET \"expiresAt\"=NOW()-interval \'1 minute\' WHERE id=$1',[req.body.id]);else await query('UPDATE share_links SET \"isActive\"=false WHERE id=$1',[req.body.id]);return res.json({ok:true});}
    return res.status(404).end();
   }catch(error){return res.status(500).json({message:error.message});}
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
 await app.init(); require('node:https').createServer({key:fs.readFileSync('/cert/key.pem'),cert:fs.readFileSync('/cert/cert.pem')},app.getHttpAdapter().getInstance()).listen(3000,'0.0.0.0');event('boot',{mode});
 fs.writeFileSync('/tmp/browser-ready.json',JSON.stringify({ready:true,schema,mode,devices:{hdd:String(fs.statSync('/storage').dev),ssd:String(fs.statSync('/ssd').dev)}}));
}
(async()=>{
 process.env.NODE_ENV='test';process.env.DB_PASSWORD=decodeURIComponent(originalUrl.password);
 process.env.REDIS_PASSWORD=randomBytes(24).toString('hex');process.env.JWT_SECRET=randomBytes(32).toString('hex');process.env.JWT_REFRESH_SECRET=randomBytes(32).toString('hex');
 process.env.MAX_CHUNK_SIZE='10485760';process.env.MAX_FILE_SIZE='67108864';process.env.MAX_TOTAL_SIZE='268435456';
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
