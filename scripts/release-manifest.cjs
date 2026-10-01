#!/usr/bin/env node
'use strict';
// Local immutable pair contract. Registry distribution requires separate digest qualification.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const ID = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
function fail(message) { throw new Error(message); }
function git(root, args) { return cp.execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio:['ignore','pipe','pipe']}).trim(); }
function source(root, explicitCommit) {
  const commit = explicitCommit || git(root, ['rev-parse','HEAD']);
  if (!COMMIT.test(commit)) fail('invalid source commit');
  if (fs.existsSync(path.join(root,'.git')) && (git(root,['rev-parse','HEAD']) !== commit || git(root, ['diff','--name-only','HEAD']))) fail('tracked source changes present');
  const dir = path.join(root,'backend/src/migrations');
  const candidates = fs.readdirSync(dir).filter(name => /\.(ts|js)$/.test(name));
  if (candidates.some(name => !/^\d+-[A-Za-z0-9]+\.ts$/.test(name))) fail('unsupported migration filename');
  const files = candidates.sort();
  if (!files.length) fail('missing migration source');
  const migrations = files.map(name => { const bytes=fs.readFileSync(path.join(dir,name)); const match=bytes.toString().match(/export class ([A-Za-z0-9]+)/); if (!match) fail('invalid migration class'); return {name, class_name:match[1], sha256:hash(bytes)}; });
  if (new Set(migrations.map(item=>item.class_name)).size !== migrations.length) fail('invalid duplicate migration class');
  const entityDir=path.join(root,'backend/src/entities');
  const mappings=['backend/src/data-source.ts',...fs.readdirSync(entityDir).filter(n=>n.endsWith('.ts')).sort().map(n=>'backend/src/entities/'+n)].map(name=>({name,sha256:hash(fs.readFileSync(path.join(root,name)))}));
  const source_files = ['backend','frontend'].flatMap(role=>{ const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).filter(e=>!['node_modules','dist','.git'].includes(e.name) && !e.name.startsWith('.env')).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):e.isFile()?[dir+'/'+e.name]:[]); return walk(role).sort().map(name=>({name,sha256:hash(fs.readFileSync(path.join(root,name)))})); });
  return {commit, schema: {policy:'exact-source-contract-v1', migrations, mappings, marker:hash(canonical({migrations,mappings}))}, compose_sha256:hash(fs.readFileSync(path.join(root,'docker-compose.production.yml'))), source_sha256:hash(canonical(source_files))};
}
function dockerInspect(id) {
  if (!ID.test(id)) fail('immutable local image ID required');
  try { return JSON.parse(cp.execFileSync('docker',['image','inspect',id], {encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0]; }
  catch { fail('image unavailable'); }
}
function image(id, role, commit, inspect = dockerInspect) {
  if (!ID.test(id || '')) fail('immutable local image ID required');
  const found = inspect(id);
  const labels = found?.Config?.Labels || {};
  if (found?.Id !== id) fail('image ID mismatch');
  if (labels['org.opencontainers.image.revision'] !== commit) fail('image source commit mismatch');
  if (labels['io.homecloud.role'] !== role) fail('image role mismatch');
  if (labels['io.homecloud.pair'] !== commit) fail('mixed image pair');
  return {image_id:id, source_commit:commit, role, pair:commit};
}
function identity(manifest) {
  const {release_id, ...body} = manifest;
  return 'sha256:'+hash(canonical(body));
}
function generate(root, backend, frontend, inspect = dockerInspect, explicitCommit) {
  const inputs = source(root, explicitCommit);
  const body = {format:'homecloud-release-v1', source_commit:inputs.commit,
    images:{backend:image(backend,'backend',inputs.commit,inspect), frontend:image(frontend,'frontend',inputs.commit,inspect)},
    schema:inputs.schema, source_sha256:inputs.source_sha256, compose_sha256:inputs.compose_sha256, distribution:'local-image-id'};
  return {...body, release_id:identity(body)};
}
function shape(manifest) {
  if (!manifest || manifest.format !== 'homecloud-release-v1' || !COMMIT.test(manifest.source_commit || '')) fail('invalid manifest format');
  if (manifest.distribution !== 'local-image-id') fail('unsupported distribution');
  const allowed = ['format','source_commit','images','schema','source_sha256','compose_sha256','distribution','release_id'];
  if (Object.keys(manifest).some(key => !allowed.includes(key))) fail('unexpected manifest field');
  if (!/^[a-f0-9]{64}$/.test(manifest.source_sha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.compose_sha256 || '')) fail('invalid compose checksum');
  const schema = manifest.schema;
  if (!schema || schema.policy !== 'exact-source-contract-v1' || !Array.isArray(schema.migrations) || !schema.migrations.length) fail('invalid schema marker');
  const names = schema.migrations.map(item => item.name);
  if (new Set(schema.migrations.map(item=>item.class_name)).size !== schema.migrations.length) fail('invalid duplicate migration class');
  if (new Set(names).size !== names.length || canonical(names) !== canonical([...names].sort())) fail('invalid migration set');
  for (const item of schema.migrations) {
    if (!/^\d+-[A-Za-z0-9]+\.ts$/.test(item.name || '') || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || Object.keys(item).join(',') !== 'name,class_name,sha256' || !/^[A-Za-z0-9]+$/.test(item.class_name || '')) fail('invalid migration reference');
  }
  if (!Array.isArray(schema.mappings) || !schema.mappings.length || schema.mappings.some(item=>!/^backend\/src\/(data-source\.ts|entities\/[A-Za-z0-9.-]+\.ts)$/.test(item.name || '') || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || Object.keys(item).join(',') !== 'name,sha256') || schema.marker !== hash(canonical({migrations:schema.migrations,mappings:schema.mappings}))) fail('schema marker mismatch');
  if (Object.keys(schema).join(',') !== 'policy,migrations,mappings,marker') fail('unexpected schema field');
  if (!manifest.images || Object.keys(manifest.images).join(',') !== 'backend,frontend') fail('full image pair required');
  for (const role of ['backend','frontend']) {
    const entry = manifest.images[role];
    if (!entry || Object.keys(entry).join(',') !== 'image_id,source_commit,role,pair' || !ID.test(entry.image_id || '')) fail('immutable full pair required');
    if (entry.role !== role || entry.source_commit !== manifest.source_commit || entry.pair !== manifest.source_commit) fail('mixed image pair');
  }
  if (manifest.release_id !== identity(manifest)) fail('manifest identity mismatch');
}
function compatible(previous, current) {
  shape(previous); shape(current);
  if (canonical(previous.schema) !== canonical(current.schema)) fail('incompatible schema: application rollback blocked');
  return true;
}
function validate(manifest, root, inspect = dockerInspect, current = null, explicitCommit, applied) {
  shape(manifest);
  if (root) {
    const inputs = source(root, explicitCommit);
    if (inputs.source_sha256 !== manifest.source_sha256) fail('manifest source tree mismatch');
    if (inputs.commit !== manifest.source_commit) fail('manifest source commit mismatch');
    if (canonical(inputs.schema) !== canonical(manifest.schema)) fail('incompatible source schema');
    if (inputs.compose_sha256 !== manifest.compose_sha256) fail('compose checksum mismatch');
  }
  for (const role of ['backend','frontend']) image(manifest.images[role].image_id,role,manifest.source_commit,inspect);
  if (current) compatible(manifest,current);
  if (applied !== undefined) {
    const expected=manifest.schema.migrations.map(item=>item.class_name).sort();
    if (!Array.isArray(applied) || applied.some(name=>typeof name !== 'string') || canonical([...applied].sort()) !== canonical(expected)) fail('incompatible applied migrations: application rollback blocked');
  }
  return true;
}
function override(manifest) {
  shape(manifest);
  return {services: Object.fromEntries(['backend','frontend'].map(role => [role,{image:manifest.images[role].image_id, build:null, pull_policy:'never', labels:{'io.homecloud.release':manifest.release_id}}]))};
}
function renderOverride(manifest) {
  shape(manifest);
  return 'services:\n'+['backend','frontend'].map(role => '  '+role+':\n    image: '+manifest.images[role].image_id+'\n    build: !reset null\n    pull_policy: never\n    labels:\n      io.homecloud.release: '+manifest.release_id+'\n').join('');
}
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function write(file, value) { fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}); }
function main(argv) {
  const mode = argv.shift(); const opts = {};
  while (argv.length) { const key = argv.shift(); if (!/^--[a-z-]+$/.test(key) || !argv.length || opts[key]) fail('invalid arguments'); opts[key] = argv.shift(); }
  const allowed = mode === 'generate' ? ['--source-root','--source-commit','--backend','--frontend','--output'] : ['--manifest','--source-root','--source-commit','--compatibility-manifest','--applied-migrations','--output'];
  if (Object.keys(opts).some(key => !allowed.includes(key))) fail('unknown argument');
  if (mode === 'generate') {
    if (!opts['--source-root'] || !opts['--output']) fail('source root and output required');
    write(opts['--output'],generate(path.resolve(opts['--source-root']),opts['--backend'],opts['--frontend'],dockerInspect,opts['--source-commit']));
  } else if (mode === 'validate' || mode === 'override') {
    if (!opts['--manifest']) fail('manifest required');
    const manifest = read(opts['--manifest']);
    const current = opts['--compatibility-manifest'] ? read(opts['--compatibility-manifest']) : null;
    // Current schema compatibility does not replace live migration preflight.
    if (mode === 'override' && (!current || !opts['--applied-migrations'])) fail('missing rollback compatibility inputs');
    validate(manifest,opts['--source-root'] && path.resolve(opts['--source-root']),dockerInspect,current,opts['--source-commit'],opts['--applied-migrations'] ? read(opts['--applied-migrations']) : undefined);
    if (mode === 'override') { if (!opts['--output']) fail('output required'); fs.writeFileSync(opts['--output'],renderOverride(manifest),{mode:0o600}); }
  } else fail('usage: release-manifest.cjs generate|validate|override');
  console.log('RELEASE_MANIFEST: PASS');
}
module.exports = {hash, identity, source, generate, shape, compatible, validate, override, renderOverride, image};
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    // Docker/config logs may contain sensitive metadata; expose only controlled errors.
    const known = /^(invalid |missing |tracked |immutable |image |mixed |unsupported |unexpected |full |schema |manifest |compose |incompatible |source root |unknown |output |usage:)/;
    console.error('RELEASE_MANIFEST: FAIL ('+(known.test(error.message) ? error.message : 'invalid or unavailable inputs')+')'); process.exitCode = 1;
  }
}
