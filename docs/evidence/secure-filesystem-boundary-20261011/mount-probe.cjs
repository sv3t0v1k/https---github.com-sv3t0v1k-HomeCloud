// Test-only privileged operations confined to a fresh user+mount namespace.
// Namespace uid0 maps ONLY host uid1001; no host root, volume, DB or network access.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {spawnSync,execFileSync}=require('node:child_process');
const {linuxMountIdentity}=require('/app/dist/storage/storage-mount-registry');
assert.equal(process.platform,'linux');assert.equal(fs.existsSync('/storage'),false);
assert.equal(process.getuid(),0);
const mapping=fs.readFileSync('/proc/self/uid_map','utf8').trim().split(/\s+/).map(Number);
assert.deepEqual(mapping,[0,1001,1],'namespace root must map only unprivileged host UID1001');
const scratch=fs.mkdtempSync('/tmp/hc-ms3br-mount-'),root=scratch+'/mount';
const report={scope:'actual disposable tmpfs in private user/mount namespace; NOT runtime identity enforcement',uidMap:mapping,seccomp:'unconfined only for isolated test',applicationSecureOpen:false,activation:'disabled'};
const mounted=()=>linuxMountIdentity(root,fs.readFileSync('/proc/self/mountinfo','utf8'));
const captureSource=`
const fs=require('node:fs');const root=process.argv[1];
const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
const st=fs.fstatSync(fd),info=fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8');
const tmp=fs.lstatSync(root+'/.tmp');
console.log(JSON.stringify({dev:st.dev,ino:st.ino,mntId:info.match(/^mnt_id:\\s+(\\d+)/m)[1],workspaceDev:tmp.dev,workspaceIno:tmp.ino}));fs.closeSync(fd);`;
function capture(){const child=spawnSync(process.execPath,['-e',captureSource,root],{encoding:'utf8'});assert.equal(child.status,0);return JSON.parse(child.stdout);}
let live=false;
try{
 assert.equal(fs.existsSync(root),false);report.absent='PASS: absent test root observed; no runtime enrollment tested';
 // Only test harness provisions this root; there is no enrollment/runtime provisioning.
 fs.mkdirSync(root);assert.equal(mounted(),undefined);assert.deepEqual(fs.readdirSync(root),[]);
 report.emptyUnderlying='PASS: actual plain empty root has no exact mount';
 execFileSync('/bin/mount',['-t','tmpfs','-o','size=1m,nosuid,nodev,noexec','tmpfs',root]);live=true;
 assert.equal(JSON.parse(mounted().fingerprint)[5],'tmpfs');
 fs.mkdirSync(root+'/.tmp');fs.writeFileSync(root+'/marker','public-cloneable-label');
 const original=capture(),restart=capture();assert.deepEqual(restart,original);
 const unique=()=>JSON.parse(execFileSync('/usr/local/bin/homecloud-ms3br-kernel-probe',['--observe-cwd-unique-id'],{cwd:root,encoding:'utf8'})).uniqueMountId;
 const originalUnique=unique();assert.equal(unique(),originalUnique);
 report.processRestart={identityEqual:true,original,scope:'fresh processes observe same object, not deployed enrollment'};
 fs.renameSync(root+'/.tmp',root+'/saved-workspace');fs.mkdirSync(root+'/.tmp');
 const substituted=capture();assert.notDeepEqual(substituted,original);
 report.substitutedWorkspace={identityChanged:true,substituted,scope:'observed difference; application rejection is absent'};
 // Actual process SIGKILL after durable file+rename+directory sync, small fixture only.
 const crashSource=`
 const fs=require('node:fs');const root=process.argv[1];
 const fd=fs.openSync(root+'/.tmp/staging','wx',0o600);fs.writeSync(fd,Buffer.from([0,255,128,0,1]));fs.fsyncSync(fd);fs.closeSync(fd);
 fs.renameSync(root+'/.tmp/staging',root+'/.tmp/chunk');
 const dir=fs.openSync(root+'/.tmp','r');fs.fsyncSync(dir);fs.closeSync(dir);process.kill(process.pid,'SIGKILL');`;
 const crashed=spawnSync(process.execPath,['-e',crashSource,root]);assert.equal(crashed.signal,'SIGKILL');
 assert.deepEqual(fs.readFileSync(root+'/.tmp/chunk'),Buffer.from([0,255,128,0,1]));
 report.crashRecovery='PASS: fixture process SIGKILL after fsync; no DB/service/power-loss guarantee';
 execFileSync('/bin/umount',[root]);live=false;
 assert.equal(mounted(),undefined);assert.deepEqual(fs.readdirSync(root),[]);
 report.unmount='PASS: normal unmount exposes empty underlying dir; no runtime fallback exercised';
 // Substituted plain directory with copied label is still not an exact mount.
 fs.renameSync(root,scratch+'/saved-underlying');fs.mkdirSync(root);
 fs.writeFileSync(root+'/marker','public-cloneable-label');assert.equal(mounted(),undefined);
 report.substitutedRoot='PASS: copied marker on plain root has no exact namespace mount';
 fs.unlinkSync(root+'/marker');
 execFileSync('/bin/mount',['-t','tmpfs','-o','size=1m,nosuid,nodev,noexec','tmpfs',root]);live=true;
 fs.mkdirSync(root+'/.tmp');fs.writeFileSync(root+'/marker','public-cloneable-label');
 const remounted=capture(),remountedUnique=unique();assert.notEqual(remountedUnique,originalUnique);
 report.remount={remounted,originalUniqueMountId:originalUnique,remountedUniqueMountId:remountedUnique,uniqueMountIdChanged:true,ordinaryMountIdReused:remounted.mntId===original.mntId,fullObservedTupleReused:JSON.stringify(remounted)===JSON.stringify(original),securityResult:'ordinary mnt_id/dev/ino tuple not durable identity',scope:'new tmpfs instance; not physical same-disk remount'};
 execFileSync('/bin/umount',[root]);live=false;
 assert.equal(mounted(),undefined);assert.deepEqual(fs.readdirSync(root),[]);
 report.physicalDisk='UNQUALIFIED';report.runtimeMountPolicy='default seccomp denies unshare; test-only unconfined succeeds';
}finally{
 if(live)execFileSync('/bin/umount',[root]);
 fs.rmSync(scratch,{recursive:true,force:true});
}
report.cleanup='PASS: both mounts normally unmounted, scratch removed, private namespaces/container destroyed';
console.log(JSON.stringify(report,null,2));
