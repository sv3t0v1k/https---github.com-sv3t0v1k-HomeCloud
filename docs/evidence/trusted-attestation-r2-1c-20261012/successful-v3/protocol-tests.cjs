'use strict';
const assert=require('assert'), crypto=require('crypto');
const {Verifier,sign}=require('./bridge.cjs');
const pair=crypto.generateKeyPairSync('ed25519'),wrong=crypto.generateKeyPairSync('ed25519');
const context={boot:'boot-test',observer:'observer-test',revision:7,enrollment:'operator-test',deployment:'deployment-test',ttlMs:1000,expected:{fs:'ext4',handle:'opaque'}};
const obs={handle:'opaque',mount:'consumer-instance'};
let clock=10,checks=[];
function setup(){const v=new Verifier(pair.publicKey,context,()=>clock);const q=v.challenge(obs);const t={v:1,seq:1,...context,...q,kind:'lease',state:'active'};return {v,t};}
function test(name,f){f();checks.push({name,status:'PASS'});}
test('valid lease and admission',()=>{const {v,t}=setup();assert(v.accept(sign(pair.privateKey,t)));assert.equal(v.admit(),1);});
test('absent attestation denied',()=>assert.throws(()=>setup().v.admit()));
for(const [field,value] of Object.entries({boot:'other',observer:'other',revision:6,enrollment:'other',deployment:'other',epoch:'other',nonce:'other',state:'revoked',ttlMs:2000,expected:{handle:'other'},observation:{handle:'other'},kind:'revoke',seq:0,v:2})) {
 test('wrong '+field+' denied',()=>{const {v,t}=setup();assert.throws(()=>v.accept(sign(pair.privateKey,{...t,[field]:value})));assert.throws(()=>v.admit());});
}
test('wrong signer denied',()=>{const {v,t}=setup();assert.throws(()=>v.accept(sign(wrong.privateKey,t)));});
test('tampered signature denied',()=>{const {v,t}=setup();const e=sign(pair.privateKey,t);e.body=Buffer.from('{}').toString('base64');assert.throws(()=>v.accept(e));});
test('malformed absent response denied',()=>{for(const e of [null,{}, {body:'bad',signature:'bad'}])assert.throws(()=>setup().v.accept(e));});
test('same challenge replay denied and clears lease',()=>{const {v,t}=setup(),e=sign(pair.privateKey,t);v.accept(e);assert.throws(()=>v.accept(e));assert.throws(()=>v.admit());});
test('new challenge rejects previous nonce',()=>{const {v,t}=setup();v.challenge(obs);assert.throws(()=>v.accept(sign(pair.privateKey,t)));});
test('process recreation rejects previous epoch',()=>{const {t}=setup();assert.throws(()=>setup().v.accept(sign(pair.privateKey,t)));});
test('response at deadline denied',()=>{const {v,t}=setup();clock+=1000;assert.throws(()=>v.accept(sign(pair.privateKey,t)));});
test('lease expiry denies next I/O',()=>{const {v,t}=setup();v.accept(sign(pair.privateKey,t));clock+=1000;assert.throws(()=>v.admit());});
test('delayed response cannot extend lease',()=>{const {v,t}=setup();clock+=900;v.accept(sign(pair.privateKey,t));clock+=100;assert.throws(()=>v.admit());});
test('renewal invalidates prior lease',()=>{const {v,t}=setup();v.accept(sign(pair.privateKey,t));v.challenge(obs);assert.throws(()=>v.admit());});
test('signed revoke fences admitted session',()=>{const {v,t}=setup();v.accept(sign(pair.privateKey,t));const admitted=v.admit();v.revoke(sign(pair.privateKey,{...t,seq:2,kind:'revoke'}));assert.throws(()=>v.admit());assert.equal(admitted,1);assert.throws(()=>v.challenge(obs));});
test('channel failure fences',()=>{const {v,t}=setup();v.accept(sign(pair.privateKey,t));assert.throws(()=>v.revoke(null));assert.throws(()=>v.admit());});
console.log(JSON.stringify({scope:'deterministic protocol model; synthetic clock/context',checks,count:checks.length}));
