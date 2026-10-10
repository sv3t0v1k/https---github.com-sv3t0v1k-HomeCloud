const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const elf=p=>{const b=fs.readFileSync(p);return {path:p,class:b[4],endian:b[5],machine:b.readUInt16LE(18),sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const paths=['/usr/local/bin/node','/app/native/secure-fs.node'];
console.log(JSON.stringify({arch:process.arch,node:process.version,napi:process.versions.napi,uid:process.getuid(),uname:cp.execFileSync('uname',['-a']).toString().trim(),artifacts:paths.map(elf),status:fs.readFileSync('/proc/self/status','utf8').split('\n').filter(l=>/^(Seccomp|Cap|NoNewPrivs)/.test(l)),emulationMaps:fs.readFileSync('/proc/self/maps','utf8').split('\n').filter(l=>/qemu|rosetta/i.test(l))},null,2));
const addon=require('/app/native/secure-fs.node');
try {const c=addon.root('/qualified');addon.close(c);console.log('ADDON_ROOT=PASS');}catch(e){console.log('ADDON_ROOT='+e.code);}
