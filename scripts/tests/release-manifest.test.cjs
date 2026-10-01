'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const path = require('node:path');
const m = require('../release-manifest.cjs');
const commit='a'.repeat(40), other='b'.repeat(40), backend='sha256:'+'1'.repeat(64), frontend='sha256:'+'2'.repeat(64);
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'homecloud-manifest-'));
  for (const dir of ['backend/src/migrations','backend/src/entities','frontend/src']) fs.mkdirSync(path.join(root,dir),{recursive:true});
  const files={'backend/src/migrations/123-Example.ts':'export class Example123 {}','backend/src/entities/user.entity.ts':'class User {}','backend/src/data-source.ts':'const migrations=[];','backend/Dockerfile':'FROM node','backend/package-lock.json':'{}','frontend/src/app.ts':'export const app=1;','frontend/Dockerfile':'FROM nginx','docker-compose.production.yml':'services: {}'};
  for (const [name,content] of Object.entries(files)) fs.writeFileSync(path.join(root,name),content);
  return root;
}
function inspect(id) { if (![backend,frontend].includes(id)) throw Error('image unavailable'); return {Id:id,Config:{Labels:{'org.opencontainers.image.revision':commit,'io.homecloud.role':id===backend?'backend':'frontend','io.homecloud.pair':commit}}}; }
function manifest(root) { return m.generate(root,backend,frontend,inspect,commit); }
function mutate(value, fn) { const copy=structuredClone(value); fn(copy); copy.release_id=m.identity(copy); return copy; }
function check(fn) { const root=fixture(); try { fn(root,manifest(root)); } finally { fs.rmSync(root,{recursive:true,force:true}); } }
test('generation is deterministic, full pair validates and override pins IDs without build/pull',()=>check((root,value)=>{assert.deepEqual(value,manifest(root)); assert.equal(m.validate(value,root,inspect,value,commit,['Example123']),true); const out=m.override(value); assert.equal(out.services.backend.image,backend); assert.equal(out.services.frontend.image,frontend); assert.equal(out.services.backend.build,null); assert.equal(out.services.frontend.pull_policy,'never'); assert.doesNotMatch(JSON.stringify(value),/timestamp|password|secret/i);}));
test('missing backend rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>delete v.images.backend)))));
test('missing frontend rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>delete v.images.frontend)))));
test('mutable tags rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>v.images.backend.image_id='homecloud:latest')))));
test('wrong immutable image content rejected',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,id=>({...inspect(id),Id:frontend})),/image ID mismatch/)));
test('nonexistent previous artifact rejected',()=>check((root,value)=>assert.throws(()=>m.validate(mutate(value,v=>v.images.backend.image_id='sha256:'+'3'.repeat(64)),null,inspect),/unavailable/)));
test('mixed pair in manifest rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>v.images.frontend.pair=other)),/mixed/)));
test('mixed pair image provenance rejected',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,id=>{const out=inspect(id); out.Config.Labels['io.homecloud.pair']=other; return out;}),/mixed/)));
test('image source commit mismatch rejected',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,id=>{const out=inspect(id); out.Config.Labels['org.opencontainers.image.revision']=other; return out;}),/source commit/)));
test('source archive commit mismatch rejected',()=>check((root,value)=>assert.throws(()=>m.validate(value,root,inspect,null,other),/source commit/)));
test('changed source files rejected',()=>check((root,value)=>{fs.writeFileSync(path.join(root,'frontend/src/app.ts'),'changed'); assert.throws(()=>m.validate(value,root,inspect,null,commit),/source tree/);}));
test('modified migration marker rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>v.schema.marker='0'.repeat(64))),/schema marker/)));
test('changed migrations block compatibility',()=>check((root,value)=>{fs.writeFileSync(path.join(root,'backend/src/migrations/123-Example.ts'),'export class Example123 { changed=true; }'); assert.throws(()=>m.compatible(value,manifest(root)),/incompatible schema/);}));
test('changed entity mappings block compatibility',()=>check((root,value)=>{fs.writeFileSync(path.join(root,'backend/src/entities/user.entity.ts'),'class Changed {}'); assert.throws(()=>m.compatible(value,manifest(root)),/incompatible schema/);}));
test('missing live migrations block rollback',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,inspect,value,undefined,[]),/applied migrations/)));
test('extra live migrations block rollback',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,inspect,value,undefined,['Example123','Future456']),/applied migrations/)));
test('duplicate live migrations block rollback',()=>check((root,value)=>assert.throws(()=>m.validate(value,null,inspect,value,undefined,['Example123','Example123']),/applied migrations/)));
test('manifest identity tampering rejected',()=>check((root,value)=>{value.images.backend.image_id='sha256:'+'3'.repeat(64); assert.throws(()=>m.shape(value),/identity/);}));
test('missing production compose fails generation',()=>check((root)=>{fs.unlinkSync(path.join(root,'docker-compose.production.yml')); assert.throws(()=>manifest(root));}));
test('unexpected secret-bearing field rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>v.password='example')),/unexpected/)));

test('unsupported TypeScript migration filename blocks generation',()=>check((root)=>{fs.writeFileSync(path.join(root,'backend/src/migrations/untracked-change.ts'),'export class Future456 {}'); assert.throws(()=>manifest(root),/unsupported migration filename/);}));
test('JavaScript migration outside source policy blocks generation',()=>check((root)=>{fs.writeFileSync(path.join(root,'backend/src/migrations/456-Future.js'),'export class Future456 {}'); assert.throws(()=>manifest(root),/unsupported migration filename/);}));
test('duplicate migration classes block generation',()=>check((root)=>{fs.writeFileSync(path.join(root,'backend/src/migrations/456-Future.ts'),'export class Example123 {}'); assert.throws(()=>manifest(root),/duplicate migration class/);}));
test('duplicate classes in manifest rejected',()=>check((root,value)=>assert.throws(()=>m.shape(mutate(value,v=>{v.schema.migrations.push({...v.schema.migrations[0],name:'456-Future.ts'}); v.schema.marker=m.hash(JSON.stringify({migrations:v.schema.migrations,mappings:v.schema.mappings}));})),/duplicate migration class/)));

test('rendered Compose override explicitly resets build and retains immutable full pair',()=>check((root,value)=>{
  const yaml=m.renderOverride(value);
  assert.equal(yaml,m.renderOverride(value));
  assert.equal((yaml.match(/build: !reset null/g)||[]).length,2);
  assert.equal((yaml.match(/pull_policy: never/g)||[]).length,2);
  assert.ok(yaml.includes('image: '+backend)); assert.ok(yaml.includes('image: '+frontend));
}));
test('actual Compose merge removes both inherited build contexts',()=>check((root,value)=>{
  const base=path.join(root,'base.yml'), overlay=path.join(root,'override.yml');
  fs.writeFileSync(base,'services:\n  backend:\n    build: ./backend\n  frontend:\n    build: ./frontend\n');
  fs.writeFileSync(overlay,m.renderOverride(value));
  const config=JSON.parse(cp.execFileSync('docker',['compose','-f',base,'-f',overlay,'config','--format','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  for (const [role,id] of [['backend',backend],['frontend',frontend]]) {
    assert.equal(config.services[role].image,id); assert.equal(config.services[role].pull_policy,'never');
    assert.equal(config.services[role].build,undefined);
  }
}));
