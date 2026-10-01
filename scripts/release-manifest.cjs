#!/usr/bin/env node
'use strict';
// Immutable local and registry pair contracts; external target qualification is separate.
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
  if (!ID.test(id) && !registryRef(id)) fail('immutable image reference required');
  try { return JSON.parse(cp.execFileSync('docker',['image','inspect',id], {encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0]; }
  catch { fail('image unavailable'); }
}
const REPOSITORY = /^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
function registryRef(ref) {
  if (typeof ref !== 'string') return false;
  const parts=ref.split('@');
  const port=parts[0].split('/')[0].split(':')[1];
  return parts.length===2 && (!port || Number(port)<=65535) && REPOSITORY.test(parts[0]) && ID.test(parts[1]);
}
function reference(manifest,role) {
  const e=manifest.images[role];
  return manifest.distribution==='registry-digest' ? e.repository+'@'+e.digest : e.image_id;
}
function registryImage(ref,role,commit,inspect=dockerInspect) {
  if (!registryRef(ref)) fail('invalid registry digest reference');
  const found=inspect(ref);
  if (!found?.RepoDigests?.includes(ref)) fail('image registry digest mismatch');
  image(found.Id,role,commit,()=>found);
  const [repository,digest]=ref.split('@');
  return {repository,digest,source_commit:commit,role,pair:commit};
}
function distribute(manifest,backend,frontend,inspect=dockerInspect) {
  shape(manifest);
  if (manifest.distribution!=='local-image-id') fail('unsupported distribution');
  for (const [role,ref] of [['backend',backend],['frontend',frontend]]) {
    if (!registryRef(ref)) fail('invalid registry digest reference');
    const found=inspect(ref);
    if (found?.Id!==manifest.images[role].image_id && ref.split('@')[1]!==manifest.images[role].image_id) fail('image qualified artifact mismatch');
  }
  const body={...manifest,distribution:'registry-digest',images:{backend:registryImage(backend,'backend',manifest.source_commit,inspect),frontend:registryImage(frontend,'frontend',manifest.source_commit,inspect)}};
  delete body.release_id;
  return {...body,release_id:identity(body)};
}
// Pull the complete pair and verify provenance before an operator changes active services.
function prepare(manifest,pull=ref=>cp.execFileSync('docker',['pull',ref],{stdio:['ignore','pipe','pipe']}),inspect=dockerInspect) {
  shape(manifest);
  if (manifest.distribution!=='registry-digest') fail('unsupported distribution');
  for (const role of ['backend','frontend']) pull(reference(manifest,role));
  validate(manifest,null,inspect);
  return true;
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
  if (!['local-image-id','registry-digest'].includes(manifest.distribution)) fail('unsupported distribution');
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
    if (!entry) fail('immutable full pair required');
    if (manifest.distribution==='local-image-id') {
      if (Object.keys(entry).join(',') !== 'image_id,source_commit,role,pair' || !ID.test(entry.image_id || '')) fail('immutable full pair required');
    } else if (Object.keys(entry).join(',') !== 'repository,digest,source_commit,role,pair' || !registryRef(entry.repository+'@'+entry.digest)) fail('invalid registry digest reference');
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
  for (const role of ['backend','frontend']) {
    if (manifest.distribution==='registry-digest') registryImage(reference(manifest,role),role,manifest.source_commit,inspect);
    else image(manifest.images[role].image_id,role,manifest.source_commit,inspect);
  }
  if (current) compatible(manifest,current);
  if (applied !== undefined) {
    const expected=manifest.schema.migrations.map(item=>item.class_name).sort();
    if (!Array.isArray(applied) || applied.some(name=>typeof name !== 'string') || canonical([...applied].sort()) !== canonical(expected)) fail('incompatible applied migrations: application rollback blocked');
  }
  return true;
}
function override(manifest) {
  shape(manifest);
  return {services: Object.fromEntries(['backend','frontend'].map(role => [role,{image:reference(manifest,role), build:null, pull_policy:manifest.distribution==='registry-digest'?'always':'never', labels:{'io.homecloud.release':manifest.release_id}}]))};
}
function renderOverride(manifest) {
  shape(manifest);
  return 'services:\n'+['backend','frontend'].map(role => '  '+role+':\n    image: '+reference(manifest,role)+'\n    build: !reset null\n    pull_policy: '+(manifest.distribution==='registry-digest'?'always':'never')+'\n    labels:\n      io.homecloud.release: '+manifest.release_id+'\n').join('');
}
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function write(file, value) { fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}); }
function main(argv) {
  const mode = argv.shift(); const opts = {};
  while (argv.length) { const key = argv.shift(); if (!/^--[a-z-]+$/.test(key) || !argv.length || opts[key]) fail('invalid arguments'); opts[key] = argv.shift(); }
  const allowed = mode === 'distribute' ? ['--manifest','--backend','--frontend','--output'] : mode === 'prepare' ? ['--manifest'] : mode === 'generate' ? ['--source-root','--source-commit','--backend','--frontend','--output'] : ['--manifest','--source-root','--source-commit','--compatibility-manifest','--applied-migrations','--output'];
  if (Object.keys(opts).some(key => !allowed.includes(key))) fail('unknown argument');
  if (mode === 'distribute') {
    if (!opts['--manifest'] || !opts['--output']) fail('missing manifest or output');
    write(opts['--output'],distribute(read(opts['--manifest']),opts['--backend'],opts['--frontend']));
  } else if (mode === 'prepare') {
    if (!opts['--manifest']) fail('manifest required');
    prepare(read(opts['--manifest']));
  } else if (mode === 'generate') {
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
  } else fail('usage: release-manifest.cjs generate|distribute|prepare|validate|override');
  console.log('RELEASE_MANIFEST: PASS');
}
module.exports = {hash, identity, source, generate, shape, compatible, validate, override, renderOverride, image, registryRef, reference, registryImage, distribute, prepare};
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    // Docker/config logs may contain sensitive metadata; expose only controlled errors.
    const known = /^(invalid |missing |tracked |immutable |image |mixed |unsupported |unexpected |full |schema |manifest |compose |incompatible |source root |unknown |output |usage:)/;
    console.error('RELEASE_MANIFEST: FAIL ('+(known.test(error.message) ? error.message : 'invalid or unavailable inputs')+')'); process.exitCode = 1;
  }
}
