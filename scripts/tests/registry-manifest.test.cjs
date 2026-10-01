'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),m=require('../release-manifest.cjs');
const local=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../../docs/evidence/immutable-release/current-manifest.json')));
const refs={backend:'localhost:5000/hc/backend@sha256:'+'1'.repeat(64),frontend:'localhost:5000/hc/frontend@sha256:'+'2'.repeat(64)};
function inspect(ref){const role=Object.keys(refs).find(r=>refs[r]===ref);return {Id:local.images[role].image_id,RepoDigests:[ref],Config:{Labels:{'org.opencontainers.image.revision':local.source_commit,'io.homecloud.role':role,'io.homecloud.pair':local.source_commit}}};}
const value=m.distribute(local,refs.backend,refs.frontend,inspect);
function changed(fn){const c=structuredClone(value);fn(c);c.release_id=m.identity(c);return c;}
test('registry pair binds repositories and digests, omits local identity and secrets',()=>{m.validate(value,null,inspect,value,undefined,local.schema.migrations.map(x=>x.class_name));assert.equal(value.images.backend.image_id,undefined);assert.equal(m.override(value).services.backend.image,refs.backend);assert.equal(m.override(value).services.frontend.pull_policy,'always');});
for(const ref of ['hc/backend:latest','localhost:5000/hc/backend:latest','https://registry.example/hc/backend@sha256:'+'1'.repeat(64),'user:password@registry.example/hc/backend@sha256:'+'1'.repeat(64),'registry.example/../backend@sha256:'+'1'.repeat(64),'registry.example/hc/backend@sha256:bad'])test('invalid ref rejected '+ref,()=>assert.equal(m.registryRef(ref),false));
test('digest tampering rejected by identity',()=>{const c=structuredClone(value);c.images.backend.digest='sha256:'+'3'.repeat(64);assert.throws(()=>m.shape(c),/identity/);});
test('registry digest mismatch rejected',()=>assert.throws(()=>m.validate(value,null,r=>({...inspect(r),RepoDigests:[]})),/digest mismatch/));
test('mixed artifact role and pair rejected',()=>assert.throws(()=>m.validate(value,null,r=>{const c=inspect(r);c.Config.Labels['io.homecloud.pair']='a'.repeat(40);return c;}),/mixed/));
test('mixed manifest pair rejected',()=>assert.throws(()=>m.shape(changed(c=>c.images.frontend.pair='a'.repeat(40))),/mixed/));
test('unexpected credential field rejected',()=>assert.throws(()=>m.shape(changed(c=>c.images.backend.token='secret')),/invalid/));
test('prepare pulls both before validation, cannot change active services',()=>{const calls=[];m.prepare(value,r=>calls.push(r),inspect);assert.deepEqual(calls,Object.values(refs));});
test('failed second pull stops preparation',()=>{let n=0;assert.throws(()=>m.prepare(value,()=>{if(++n===2)throw Error('denied');},()=>{throw Error('inspection should not happen');}),/denied/);});

test('out of range registry port rejected',()=>assert.equal(m.registryRef('localhost:65536/hc/backend@sha256:'+'1'.repeat(64)),false));

test('same labels with different qualified content rejected',()=>assert.throws(()=>m.distribute(local,refs.backend,refs.frontend,r=>({...inspect(r),Id:'sha256:'+'3'.repeat(64)})),/qualified artifact mismatch/));
test('registry reconversion cannot replace bound artifacts',()=>assert.throws(()=>m.distribute(value,refs.backend,refs.frontend,inspect),/unsupported distribution/));
