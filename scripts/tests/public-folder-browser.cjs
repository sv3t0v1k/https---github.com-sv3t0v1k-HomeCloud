/* Real Chromium + real disposable backend. No mocked API responses; one injected transport failure. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash,randomBytes}=require('node:crypto');
const {chromium}=require(process.env.HOMECLOUD_PLAYWRIGHT_DIR||'/Users/aleksejkozemakin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const work=process.env.HOMECLOUD_BROWSER_WORKDIR;
if(!work||!path.isAbsolute(work))throw Error('Absolute HOMECLOUD_BROWSER_WORKDIR required');
const fixture=JSON.parse(fs.readFileSync(path.join(work,'fixture-private.json'))),base='https://127.0.0.1:'+fixture.ports.public;
const report={browser:'Playwright Chromium',backend:'real local disposable backend; current source',checks:[],success:false,limitations:['WebKit binary unavailable; Safari NOT_RUN: safaridriver session creation reports remote automation disabled','Small local test payloads do not qualify large-file memory or production performance','Directory entry drop is synthetic; native OS drag is not qualified']};
const previous=path.join(work,'public-folder-browser.json');if(fs.existsSync(previous))fs.copyFileSync(previous,path.join(work,'public-folder-browser-previous-'+Date.now()+'.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');
let browser,page,api;
async function request(route,body,headers={}){const r=await api.fetch(base+route,{method:body===undefined?'GET':'POST',headers,data:body});assert.ok(r.ok(),`${route}: HTTP ${r.status()} ${(await r.text()).slice(0,200)}`);return (await r.json()).data;}
async function control(route,body){const r=await api.fetch(base+'/__fixture/'+route,{method:body===undefined?'GET':'POST',headers:{'x-fixture-control':fixture.controlKey},data:body});assert.equal(r.status(),200);return r.json();}
async function eventually(fn,label,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);}
const record=(name,detail={})=>{report.checks.push({name,pass:true,...detail});console.log(JSON.stringify({check:name,pass:true}));};
async function download(name,bytes){const next=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать '+name,exact:true}).click();const d=await next;assert.equal(hash(fs.readFileSync(await d.path())),hash(bytes));record('native download SHA-256',{name,size:bytes.length,sha256:hash(bytes)});}
async function select(name,bytes){await eventually(()=>page.getByRole('button',{name:'Загрузить файлы',exact:true}).isEnabled(),'upload selector enabled');await page.getByLabel('Выбрать файлы',{exact:true}).setInputFiles({name,mimeType:'application/octet-stream',buffer:bytes});}
async function published(name){return eventually(async()=>{const state=await control('state');return state.files.find(f=>f.name===name&&!f.folderId);},'published '+name);}
(async()=>{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:true});api=context.request;page=await context.newPage();page.on('pageerror',error=>{report.pageErrors??=[];report.pageErrors.push(error.message);console.log(JSON.stringify({pageError:error.message}));});page.setDefaultTimeout(12000);
 await eventually(async()=>{try{return (await api.get(base+'/login')).status()===200;}catch{return false;}},'HTTPS backend ready',60000);
 const email='public-browser-'+randomBytes(6).toString('hex')+'@example.test',password=randomBytes(20).toString('hex');
 const auth=await request('/api/v1/auth/register',{email,password,name:'Local browser fixture'}),headers={Authorization:'Bearer '+auth.accessToken};await control('quota',{email});
 const root=await request('/api/v1/files/folders',{name:'Public browser root'},headers);
 const child=await request('/api/v1/files/folders',{name:'existing',parentId:root.folderId},headers);
 const outside=await request('/api/v1/files/folders',{name:'Outside'},headers);
 const writable=await request('/api/v1/sharing',{fileId:root.id,isFolder:true,allowUpload:true},headers);
 const readonly=await request('/api/v1/sharing',{fileId:root.id,isFolder:true},headers);
 if(!process.env.HOMECLOUD_DROP_DIAGNOSTIC){await page.goto(base+'/share/'+readonly.token);await page.getByRole('button',{name:'Открыть existing',exact:true}).waitFor();await page.getByText('Только просмотр и скачивание.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Выбрать файлы',{exact:true}).count(),0);await page.getByRole('button',{name:'Открыть existing',exact:true}).click();await page.getByText('Папка пуста.',{exact:true}).waitFor();await page.getByRole('button',{name:'Общая папка',exact:true}).click();await page.getByRole('button',{name:'Открыть existing',exact:true}).waitFor();record('read-only browsing and root navigation');}
 await page.goto(base+'/share/'+writable.token);await page.getByRole('button',{name:'Загрузить файлы',exact:true}).waitFor();
 if(process.env.HOMECLOUD_DROP_DIAGNOSTIC==='1'){await page.getByLabel('Имя новой папки',{exact:true}).fill('before-drop');await page.getByRole('button',{name:'Создать папку',exact:true}).click();await page.getByRole('button',{name:'Новая загрузка',exact:true}).click();await eventually(()=>page.getByRole('button',{name:'Загрузить файлы',exact:true}).isEnabled(),'ready');await page.getByRole('region',{name:'Загрузка в общую папку',exact:true}).evaluate(element=>{const empty={name:'diagnostic-empty',isDirectory:true,createReader:()=>({readEntries:ok=>ok([])})};const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>empty}],files:[]}});element.dispatchEvent(event);});await eventually(async()=> (await control('state')).folders.some(f=>f.name==='diagnostic-empty'&&f.parentId===root.folderId),'isolated drop');record('isolated drop');report.success=true;return;}
 const bytes=Buffer.alloc(12*1024*1024+137);for(let i=0;i<bytes.length;i++)bytes[i]=(i*37+11)%251;
 await select('browser-main.bin',bytes);const main=await published('browser-main.bin');assert.equal(main.parentId,root.folderId);assert.equal(main.checksum,hash(bytes));await page.getByRole('button',{name:'Скачать browser-main.bin',exact:true}).waitFor();await download('browser-main.bin',bytes);record('multi-chunk public upload uses real backend',{size:bytes.length});await page.screenshot({path:path.join(work,'public-folder-upload-complete.png'),fullPage:true});
 await page.getByRole('button',{name:'Новая загрузка',exact:true}).click();
 // Respect the real shared attempt budget rather than disabling security middleware.
 await new Promise(resolve=>setTimeout(resolve,61000));
 // Native directory input exercises the browser-provided webkitRelativePath.
 const treeDir=path.join(work,'tree');fs.mkdirSync(path.join(treeDir,'a/b/c/d'),{recursive:true});
 fs.writeFileSync(path.join(treeDir,'a/b/c/d/deep.bin'),bytes.subarray(0,177));
 await request('/api/v1/files/folders',{name:'tree',parentId:root.folderId},headers);
 await page.evaluate(()=>Object.defineProperty(window,'showDirectoryPicker',{value:undefined,configurable:true}));
 const directoryChooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Загрузить папку',exact:true}).click();await (await directoryChooser).setFiles(treeDir);
 const deep=await published('deep.bin'),treeState=await control('state');
 const collision=treeState.folders.find(f=>f.name==='tree (1)'&&f.parentId===root.folderId);assert.ok(collision,'separate root on collision');
 let ancestor=deep.parentId;for(const name of ['d','c','b','a']){const folder=treeState.folders.find(f=>f.id===ancestor);assert.equal(folder.name,name);ancestor=folder.parentId;}assert.equal(ancestor,collision.id);assert.equal(deep.checksum,hash(bytes.subarray(0,177)));record('native filechooser fallback without showDirectoryPicker, five-level tree and collision ID mapping');await page.screenshot({path:path.join(work,'public-folder-tree.png'),fullPage:true});await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'375px no horizontal overflow');await page.screenshot({path:path.join(work,'public-folder-mobile-375.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});record('375px viewport has no horizontal overflow');
 await page.getByRole('button',{name:'Новая загрузка',exact:true}).click();
 await eventually(()=>page.getByRole('button',{name:'Загрузить файлы',exact:true}).isEnabled(),'drop target ready after new batch');
 // Synthetic FileSystemEntry drop preserves a discoverable empty directory.
 // API traffic and persisted objects remain real; this is not a native OS drag.
 await page.getByRole('region',{name:'Загрузка в общую папку',exact:true}).evaluate(element=>{
   const empty={name:'drop-empty',isDirectory:true,isFile:false,createReader:()=>({readEntries:ok=>ok([])})};
   const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>empty}],files:[]}});element.dispatchEvent(event);
 });
 await eventually(async()=> (await control('state')).folders.some(f=>f.name==='drop-empty'&&f.parentId===root.folderId),'dropped empty folder');record('synthetic entry drop empty directory, real backend mkdir');
 await page.getByRole('button',{name:'Новая загрузка',exact:true}).click();
 // Interrupt only transport delivery after one real accepted chunk; manual retry
 // must retain the original uploadId and reconcile persisted progress.
 let chunkCalls=0;const chunkRoute='**/sharing/public/*/uploads/session/*/chunk';
 await page.route(chunkRoute,route=>{chunkCalls++;return chunkCalls===1?route.continue():route.abort('connectionreset');});
 await select('retry.bin',bytes);
 await page.locator('.public-upload-result').filter({hasText:'retry.bin'}).getByText('Ошибка',{exact:true}).waitFor({timeout:30000});
 const partial=(await control('state')).sessions.find(x=>x.filename==='retry.bin');assert.ok(partial);assert.equal(partial.uploadedCount,1);
 await page.unroute(chunkRoute);await page.getByRole('button',{name:'Повторить неудачные операции',exact:true}).click();
 await published('retry.bin');const retryState=await control('state');assert.equal(retryState.sessions.filter(x=>x.filename==='retry.bin').length,1);assert.equal(retryState.sessions.find(x=>x.filename==='retry.bin').uploadId,partial.uploadId);assert.equal(retryState.files.filter(x=>x.name==='retry.bin').length,1);assert.equal(retryState.files.find(x=>x.name==='retry.bin').checksum,hash(bytes));record('injected connection reset, manual retry preserves session and one file',{acceptedBeforeRetry:1});
 // A forged parent is rejected by backend independently of client path validation.
 const proof=await request('/api/v1/sharing/public/'+writable.token+'/upload-authorizations',{});
 const forged=await api.post(base+'/api/v1/sharing/public/'+writable.token+'/folders',{headers:{'X-Share-Upload-Proof':proof.proof,'Idempotency-Key':require('node:crypto').randomUUID()},data:{parentId:outside.folderId,name:'escape'}});assert.equal(forged.status(),404);record('backend rejects parent outside share tree');
 await page.getByRole('button',{name:'Новая загрузка',exact:true}).click();
 await new Promise(resolve=>setTimeout(resolve,61000));
 await control('quota',{email,bytes:1});await select('quota.bin',bytes.subarray(0,512));
 const quotaRow=page.locator('.public-upload-result').filter({hasText:'quota.bin'});await quotaRow.getByText('Ошибка',{exact:true}).waitFor();assert.match(await quotaRow.innerText(),/квот|ограничен|отклонил/i);assert.ok(!(await control('state')).files.some(f=>f.name==='quota.bin'));await control('quota',{email});await page.getByRole('button',{name:'Повторить неудачные операции',exact:true}).click();await published('quota.bin');assert.equal((await control('state')).files.filter(f=>f.name==='quota.bin').length,1);record('real owner quota rejection, user retry after quota restored');
 const revoked=await request('/api/v1/sharing',{fileId:root.id,isFolder:true,allowUpload:true},headers);await page.goto(base+'/share/'+revoked.token);await page.getByRole('button',{name:'Загрузить файлы',exact:true}).waitFor();await control('share',{id:revoked.id});await select('revoked.bin',bytes.subarray(0,512));await page.locator('.public-upload-result').filter({hasText:'revoked.bin'}).getByText('Ошибка',{exact:true}).waitFor();assert.ok(!(await control('state')).files.some(f=>f.name==='revoked.bin'));record('real backend revoke prevents publication with cached proof');
 const expired=await request('/api/v1/sharing',{fileId:root.id,isFolder:true,allowUpload:true},headers);await page.goto(base+'/share/'+expired.token);await page.getByRole('button',{name:'Загрузить файлы',exact:true}).waitFor();await control('share',{id:expired.id,expire:true});await select('expired.bin',bytes.subarray(0,512));await page.locator('.public-upload-result').filter({hasText:'expired.bin'}).getByText('Ошибка',{exact:true}).waitFor();assert.ok(!(await control('state')).files.some(f=>f.name==='expired.bin'));record('real backend expiry prevents publication with cached proof');
 await page.screenshot({path:path.join(work,'public-folder-chromium.png'),fullPage:true});
 report.success=true;
})().catch(async error=>{report.failure={body:page?await page.locator('body').innerText().catch(()=>null):null,name:error.name,message:error.message.replace(/sharing\/public\/[^/\s]+/g,'sharing/public/[redacted]')};if(page)await page.screenshot({path:path.join(work,'public-folder-failure.png'),fullPage:true}).catch(()=>{});console.error(report.failure);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(work,'public-folder-browser.json'),JSON.stringify(report,null,2));if(browser)await browser.close();console.log(JSON.stringify({success:report.success,checks:report.checks.length,failure:report.failure}));});
