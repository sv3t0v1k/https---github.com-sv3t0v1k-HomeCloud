const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {StorageService} = require('/app/dist/storage/storage.service');
const {StorageMountRegistry,legacyBinding,bootstrapLegacyMarker,LEGACY_STORAGE_ID} = require('/app/dist/storage/storage-mount-registry');
const {ConfigService} = require('/app/node_modules/@nestjs/config');
const {StorageRegistry} = require('/app/dist/storage/storage-placement');
const service = new StorageService(new ConfigService({STORAGE_PATH:'/storage',NODE_ENV:'production'}));
const diagnostic = service.storageDiagnostic(true);
assert.equal(diagnostic.state,'online'); assert.equal(diagnostic.capabilities.secureOpen,false);
assert.throws(() => bootstrapLegacyMarker('/storage'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'hc-ms2-runtime-'));
let registry;
try {
  const before = fs.readdirSync(scratch);
  registry = new StorageMountRegistry([legacyBinding(scratch,true)]);
  assert.equal(registry.inspect(LEGACY_STORAGE_ID,true).state,'offline');
  assert.deepEqual(fs.readdirSync(scratch),before);
  assert.throws(() => bootstrapLegacyMarker(scratch));
  assert.deepEqual(fs.readdirSync(scratch),before);
  fs.rmdirSync(scratch);
  assert.equal(registry.inspect(LEGACY_STORAGE_ID,true).state,'offline');
  assert(!fs.existsSync(scratch));
  const resolver = new StorageRegistry('/storage',true);
  try {
    assert.throws(() => resolver.resolve({storageLocationId:LEGACY_STORAGE_ID,relativeObjectKey:'.homecloud-storage-identity',storagePath:'/storage/.homecloud-storage-identity'}));
    assert.throws(() => resolver.mounts.openSecure(LEGACY_STORAGE_ID));
  } finally { resolver.close(); }
  console.log(JSON.stringify({status:'PASS',platform:process.platform,node:process.version,uid:process.getuid(),euid:process.geteuid(),legacy:diagnostic,ordinaryDirectory:'OFFLINE/no writes',missingRoot:'OFFLINE/no mkdir',repeatBootstrap:'REFUSED',reservedMetadata:'REFUSED',secureDescriptor:'UNAVAILABLE/refused'}));
} finally {
  service.onModuleDestroy(); registry?.close(); fs.rmSync(scratch,{recursive:true,force:true});
}
