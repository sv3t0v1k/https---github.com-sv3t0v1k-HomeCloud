'use strict';
const fs=require('fs'),cp=require('child_process'),readline=require('readline');
const {Verifier}=require('./bridge.cjs');
const native=require('/control/observe-fd.node');
const context=JSON.parse(process.argv[2]);
const verifier=new Verifier(fs.readFileSync('/control/public.pem'),context);
const fd=native.acquire('/ext4'),xfd=native.acquire('/xfs');
function probe(fd,key){return JSON.parse(cp.execFileSync('/control/identity-probe',['@fd3',...(key?[key]:[])],{stdio:['ignore','pipe','pipe',fd],timeout:5000,encoding:'utf8'}));}
const profile=Object.fromEntries(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^(CapEff|CapPrm|NoNewPrivs|Seccomp):/.test(x)).map(x=>x.split(':').map(y=>y.trim())));
const observation={ext4:probe(fd),xfs:probe(xfd),mountns:fs.readlinkSync('/proc/self/ns/mnt')};
const out=x=>console.log(JSON.stringify(x));
out({kind:'challenge',challenge:verifier.challenge(observation),profile,arch:process.arch,node:process.version});
const rl=readline.createInterface({input:process.stdin});
let accepted=false;
rl.on('line',line=>{
 try {
  const msg=JSON.parse(line);
  if(msg.command==='lease') {
   verifier.accept(msg.envelope);verifier.admit();accepted=true;
   out({kind:'accepted',marker:probe(fd,'marker'),retained:probe(fd)});
  } else if(msg.command==='old-epoch') {
   let denied=false;try{verifier.accept(msg.envelope);}catch(e){denied=true;}
   out({kind:'old-epoch-result',denied});
   if(!denied)throw Error('old epoch accepted');
   out({kind:'challenge',challenge:verifier.challenge(observation),profile,arch:process.arch,node:process.version});
  } else if(msg.command==='replay') {
   let denied=false;try{verifier.accept(msg.envelope);}catch(e){denied=true;}
   out({kind:'replay-result',denied});
  } else if(msg.command==='revoke') {
   verifier.revoke(msg.envelope);let denied=false;try{verifier.admit();}catch(e){denied=true;}
   out({kind:'revoked',denied,acceptedBeforeRevoke:accepted});rl.close();
  } else if(msg.command==='expiry') {
   setTimeout(()=>{let denied=false;try{verifier.admit();}catch(e){denied=true;}out({kind:'expired',denied});rl.close();},context.ttlMs+20);
  } else {throw Error('unknown command');}
 } catch(e) {out({kind:'denied',reason:e.message});rl.close();process.exitCode=1;}
});
rl.on('close',()=>{fs.closeSync(fd);fs.closeSync(xfd);});
