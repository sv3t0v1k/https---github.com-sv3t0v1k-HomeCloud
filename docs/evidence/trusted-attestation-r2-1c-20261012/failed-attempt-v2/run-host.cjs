'use strict';
// Runs on hs. No mounts/unmounts, loops, physical-device writes, networks or volumes.
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto'),path=require('path'),readline=require('readline');
const payload=JSON.parse(fs.readFileSync(0,'utf8'));
const RUN='r2-1c-bridge-v2-20261012-01a12cfd',LABEL='com.homecloud.research-run';
const P='/home/hs/homecloud-test/'+RUN,D='/mnt/1TB/homecloud-test/'+RUN;
const IMAGE='sha256:c3ff13b395fdf1f251c33ff475318e1c2b8a683e268dcb25142e47d20efba90f';
const requireOK=(b,m)=>{if(!b)throw Error(m);};
const command=(args)=>cp.execFileSync(args[0],args.slice(1),{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024});
const snapshot=()=>JSON.parse(command(['python3','-I','-c',payload.files['baseline-collector.py']])).snapshot;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const before=snapshot(),own=[],records=[],result={run:RUN,gate:'BLOCKED',initial:before,records,cleanupErrors:[]};
let nsfd,hostfd,xfd,active,previousEnvelope,createdP=false;
function config(cid){
 requireOK(!before.containers.some(x=>x.startsWith(cid+'|')),'original CID forbidden');
 const c=JSON.parse(command(['docker','inspect',cid]))[0];
 requireOK(c.Id===cid&&c.Config.Labels[LABEL]===RUN&&c.Config.Image===IMAGE,'owned CID/image/label guard');
 requireOK(!c.HostConfig.Privileged&&c.HostConfig.NetworkMode==='none'&&c.HostConfig.ReadonlyRootfs&&c.Config.User==='1000:1000','own container profile');
 requireOK(equal(c.HostConfig.CapDrop,['ALL'])&&!c.HostConfig.CapAdd&&c.HostConfig.SecurityOpt.includes('no-new-privileges=true'),'own cap/NNP guard');
 return c;
}
function create(name,args,mounts){
 requireOK(command(['docker','ps','-aq','--filter','name=^/'+name+'$']).trim()==='','exclusive name');
 const cid=command(['docker','create','--pull=never','--name',name,'--label',LABEL+'='+RUN,
 '--cap-drop=ALL','--security-opt=no-new-privileges=true','--read-only','--network=none','--user=1000:1000',
 '--memory=128m','--memory-swap=128m','--cpus=0.25','--pids-limit=32',
 ...mounts.flatMap(m=>['--mount',m]),'--env','TMPDIR=/control','--env','NODE_OPTIONS=','--entrypoint',args[0],IMAGE,...args.slice(1)]).trim();
 requireOK(/^[0-9a-f]{64}$/.test(cid),'CID format');own.push(cid);config(cid);return cid;
}
function remove(cid){const c=config(cid);requireOK(!c.State.Running,'must exit before removal');command(['docker','rm',cid]);own.splice(own.indexOf(cid),1);}
function write(name,content){fs.writeFileSync(P+'/'+name,content,{flag:'wx',mode:0o600});}
function probe(fd){return JSON.parse(cp.execFileSync(P+'/identity-probe',['@fd3'],{encoding:'utf8',stdio:['ignore','pipe','pipe',fd],timeout:5000}));}
function id(o){requireOK(o.empty.rc===0&&o.unique_supported&&o.statx_rc===0,'identity unsupported');return {fs_type:o.fs_type,fsid:o.fsid,handle:{type:o.empty.type,bytes:o.empty.bytes,hex:o.empty.hex}};}
async function session(cid,phase,mode,ctx,key){
 const c=config(cid);
 const wanted=[{source:P,dst:'/control'},{source:D+'/a',dst:'/ext4'},{source:'/mnt/data',dst:'/xfs'}];
 requireOK(c.Mounts.length===3&&wanted.every(w=>c.Mounts.some(m=>m.Source===w.source&&m.Destination===w.dst&&!m.RW&&m.Propagation==='rprivate')),'consumer mount guard');
 const child=cp.spawn('docker',['start','-ai',cid],{stdio:['pipe','pipe','pipe']});active=child;
 let stderr='',events=[],envelope,triedPrevious=false;
 const timer=setTimeout(()=>{child.kill('SIGTERM');},15000);
 child.stderr.on('data',b=>stderr+=b.toString());
 const rl=readline.createInterface({input:child.stdout});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});
 rl.on('line',line=>{
  try {
   const e=JSON.parse(line);events.push(e);
   if(e.kind==='challenge') {
    requireOK(equal(e.profile,{CapPrm:'0000000000000000',CapEff:'0000000000000000',NoNewPrivs:'1',Seccomp:'2'}),'effective security profile');
    requireOK(e.arch==='x64'&&equal(id(e.challenge.observation.ext4),ctx.expected.ext4)&&equal(id(e.challenge.observation.xfs),ctx.expected.xfs),'sampled consumer object mapping');
    if(previousEnvelope&&!triedPrevious){triedPrevious=true;child.stdin.write(JSON.stringify({command:'old-epoch',envelope:previousEnvelope})+'\n');return;}
    requireOK(equal(id(probe(hostfd)),ctx.expected.ext4)&&equal(id(probe(xfd)),ctx.expected.xfs),'retained host object unchanged');
    const started=config(cid),pid=started.State.Pid;
    const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
    const workload={cid,startedAt:started.State.StartedAt,pid,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
    result.records.push({phase,workload,config:started,hostExt4:probe(hostfd),hostXfs:probe(xfd)});
    const token={v:1,...ctx,...e.challenge,kind:'lease',state:'active',seq:1,workload};
    envelope=require(P+'/bridge.cjs').sign(key,token);
    child.stdin.write(JSON.stringify({command:'lease',envelope})+'\n');
   } else if(e.kind==='accepted') {
    requireOK(e.marker.hex===Buffer.from('BRIDGE_A\n').toString('hex'),'marker bytes');
    if(mode==='revoke') {
     // Own disposable directory pathname replacement; NO mount mutation.
     fs.renameSync(D+'/a',D+'/saved-a');fs.renameSync(D+'/b',D+'/a');
     try {
      const fresh=JSON.parse(command([P+'/identity-probe',D+'/a']));
      const pinned=probe(hostfd);
      requireOK(!equal(id(fresh),id(pinned))&&equal(id(pinned),ctx.expected.ext4),'replacement experiment');
      records.push({phase:'host-directory-replacement-not-remount',fresh,pinned});
     } finally {fs.renameSync(D+'/a',D+'/b');fs.renameSync(D+'/saved-a',D+'/a');}
     const restored=JSON.parse(command([P+'/identity-probe',D+'/a']));
     requireOK(equal(id(restored),ctx.expected.ext4),'restore test source');
     records.push({phase:'ABA-sampling-limitation',restored,scope:'observations before/after equal despite intervening pathname object change'});
     const body=JSON.parse(Buffer.from(envelope.body,'base64'));
     const rev=require(P+'/bridge.cjs').sign(key,{...body,kind:'revoke',seq:2});
     child.stdin.write(JSON.stringify({command:'revoke',envelope:rev})+'\n');
    } else if(mode==='expiry')child.stdin.write(JSON.stringify({command:'expiry'})+'\n');
    else child.stdin.write(JSON.stringify({command:'replay',envelope})+'\n');
   } else if(e.kind==='revoked'||e.kind==='expired') {
    requireOK(e.denied,'post-revoke/expiry admitted');child.stdin.end();
   } else if(e.kind==='replay-result') {
    requireOK(e.denied,'replay accepted');child.stdin.end();
   }
  } catch(error) {result.cleanupErrors.push('session '+phase+': '+error.message);child.stdin.end();}
 });
 const code=await done;clearTimeout(timer);active=null;
 const final=config(cid);records.push({phase,events,exit:code,stderr,finalState:final.State});
 requireOK(code===0&&!final.State.OOMKilled&&!final.State.Running,'consumer exit');
 requireOK(events.some(e=>e.kind==='accepted')&&events.some(e=>e.kind===(mode==='revoke'?'revoked':mode==='expiry'?'expired':'replay-result')&&e.denied),'session incomplete');
 if(triedPrevious)requireOK(events.some(e=>e.kind==='old-epoch-result'&&e.denied),'old epoch not rejected');
 previousEnvelope=envelope;
}
async function main(){
 requireOK(process.getuid()===1000&&before.containers.length===26&&before.containers.every(x=>x.split('|')[5]==='true'),'initial hs/26');
 for(const field of ['containers','mountinfo','fixtures','boot_id','mount_ns','user_ns'])requireOK(equal(before[field],payload.expected[field]),'historical baseline mismatch '+field);
 requireOK(Number(command(['awk','/^MemAvailable:/ {print $2}','/proc/meminfo']).trim())>=3*1024*1024,'RAM guard');
 requireOK(command(['docker','image','inspect',IMAGE,'--format','{{.Id}}|{{.Architecture}}|{{json (index .Config "Volumes")}}']).trim()===IMAGE+'|amd64|null','cached image guard');
 for(const parent of [path.dirname(P),path.dirname(D)]){
  for(let p=parent;;p=path.dirname(p)){const s=fs.lstatSync(p);requireOK(s.isDirectory()&&!s.isSymbolicLink(),'ancestor');if(p==='/')break;}
  const s=fs.statSync(parent);requireOK(s.uid===1000&&(s.mode&0o777)===0o700,'approved owner parent');
 }
 fs.mkdirSync(P,{mode:0o700});createdP=true;fs.mkdirSync(D,{mode:0o700});
 fs.mkdirSync(D+'/a',{mode:0o700});fs.mkdirSync(D+'/b',{mode:0o700});
 fs.writeFileSync(D+'/a/marker','BRIDGE_A\n',{flag:'wx',mode:0o600});fs.writeFileSync(D+'/b/marker','BRIDGE_B\n',{flag:'wx',mode:0o600});
 for(const name of ['baseline-collector.py','identity-probe.c','observe-fd.c','bridge.cjs','protocol-tests.cjs','consumer.cjs'])write(name,payload.files[name]);
 command(['cc','-O2','-Wall','-Wextra','-Werror','-static',P+'/identity-probe.c','-o',P+'/identity-probe']);
 command(['cc','-O2','-Wall','-Wextra','-Werror','-fPIC','-shared','-I/usr/include/node',P+'/observe-fd.c','-o',P+'/host-observe.node']);
 const build=create('hc-r21c-v2-build-01a12cfd',['cc','-O2','-Wall','-Wextra','-Werror','-fPIC','-shared','-I/usr/local/include/node','/control/observe-fd.c','-o','/control/observe-fd.node'],['type=bind,src='+P+',dst=/control']);
 result.build={cid:build,config:config(build),output:command(['docker','start','-a',build]),final:config(build).State};requireOK(result.build.final.ExitCode===0,'build failure');remove(build);
 result.protocol=JSON.parse(command(['node',P+'/protocol-tests.cjs']));
 const native=require(P+'/host-observe.node');hostfd=native.acquire(D+'/a');xfd=native.acquire('/mnt/data');
 nsfd=fs.openSync('/proc/self/ns/mnt','r');
 const pair=crypto.generateKeyPairSync('ed25519');write('public.pem',pair.publicKey.export({type:'spki',format:'pem'}));
 const ctx={enrollment:'explicit-disposable-ext4-test-only',revision:1,boot:before.boot_id,observer:crypto.randomBytes(32).toString('hex'),deployment:crypto.randomBytes(32).toString('hex'),ttlMs:3000,expected:{ext4:id(probe(hostfd)),xfs:id(probe(xfd))}};
 result.context=ctx;result.hostNamespacePin={fd:nsfd,observation:fs.fstatSync(nsfd).ino};
 try{result.daemonNamespace=fs.readlinkSync('/proc/1134/ns/mnt');}catch(e){result.daemonNamespace={error:e.code};}
 const mounts=['type=bind,src='+P+',dst=/control,readonly','type=bind,src='+D+'/a,dst=/ext4,readonly','type=bind,src=/mnt/data,dst=/xfs,readonly,bind-recursive=disabled'];
 const first=create('hc-r21c-v2-consumer1-01a12cfd',['node','/control/consumer.cjs',JSON.stringify(ctx)],mounts);
 await session(first,'create','revoke',ctx,pair.privateKey);
 await session(first,'restart','replay',ctx,pair.privateKey);remove(first);
 const second=create('hc-r21c-v2-consumer2-01a12cfd',['node','/control/consumer.cjs',JSON.stringify(ctx)],mounts);
 await session(second,'recreation','expiry',ctx,pair.privateKey);remove(second);
 result.status='OBSERVED_SCOPED_PROTOCOL_AND_READONLY_CONTINUITY';
}
(async()=>{
 try{await main();}catch(e){result.error=e.stack;result.status='BLOCKED_EXECUTION';}
 finally {
  if(active)active.kill('SIGTERM');
  for(const cid of [...own])try{const c=config(cid);if(c.State.Running)command(['docker','stop','--time','2',cid]);remove(cid);}catch(e){result.cleanupErrors.push(e.message);}
  for(const fd of [hostfd,xfd,nsfd])if(fd!==undefined)fs.closeSync(fd);
  result.remainingOwned=command(['docker','ps','-aq','--filter','label='+LABEL+'='+RUN]).trim();
  result.final=snapshot();result.invariants=Object.fromEntries(['containers','mountinfo','fixtures','boot_id','mount_ns','user_ns'].map(k=>[k,equal(before[k],result.final[k])]));
  if(createdP)fs.writeFileSync(P+'/result.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result));
  process.exitCode=result.error||result.cleanupErrors.length||result.remainingOwned||Object.values(result.invariants).some(x=>!x)?1:0;
 }
})();
