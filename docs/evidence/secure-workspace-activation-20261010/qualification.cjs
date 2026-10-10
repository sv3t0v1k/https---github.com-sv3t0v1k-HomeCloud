// Run only in a disposable non-root container with /qualified as an isolated tmpfs.
// Never mount canonical /storage or expose a database to this probe.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { ConfigService } = require('/app/node_modules/@nestjs/config');
const { StorageService } = require('/app/dist/storage/storage.service');
const { UploadWorkspaceResolver, LEGACY_UPLOAD_WORKSPACE } = require('/app/dist/uploads/upload-workspace');
const { abortableDiskStorage } = require('/app/dist/uploads/abortable-disk-storage');
const { StorageMountRegistry, legacyBinding, markerContents, IDENTITY_MARKER, linuxMountIdentity } = require('/app/dist/storage/storage-mount-registry');
const report = { secureOpen: false, activation: 'disabled', securityQualification: 'BLOCKED' };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ms3b-probe-'));
const registries = [], resolvers = [], services = [];
const registry = binding => { const r = new StorageMountRegistry([binding]); registries.push(r); return r; };
const makeResolver = root => {
  // ConfigService reads inherited process.env before supplied test values.
  process.env.NODE_ENV = 'test';
  const storage = new StorageService(new ConfigService({STORAGE_PATH: root, NODE_ENV: 'test'}));
  services.push(storage);
  const resolver = new UploadWorkspaceResolver(storage); resolvers.push(resolver);
  return resolver;
};
(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 1001);
  assert.equal(fs.existsSync('/storage'), false, 'Canonical storage must not be present');
  const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const mount = linuxMountIdentity('/qualified', mountinfo);
  assert.ok(mount && !mount.readOnly, 'Dedicated writable tmpfs required');
  assert.equal(JSON.parse(mount.fingerprint)[5], 'tmpfs', 'Dedicated isolated tmpfs required');
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /CapEff:\s+0000000000000000/);
  const runtime = {
    node: process.version, platform: process.platform, kernel: os.release(), uid: process.getuid(),
    effectiveCapabilities: '0', seccomp: status.match(/^Seccomp:\s+(\d+)/m)?.[1],
    fsApi: Object.fromEntries(['openat2','openat','renameat','unlinkat'].map(k => [k, typeof fs[k]])),
    promisesOpenat2: typeof require('node:fs/promises').openat2,
    resolveFlags: Object.keys(fs.constants).filter(k => k.startsWith('RESOLVE_')),
    kernelOpenat2Syscall: 'UNPROBED; no deployed callable adapter',
  };
  report.runtime = runtime;
  const binding = legacyBinding('/qualified', true);
  fs.writeFileSync('/qualified/' + IDENTITY_MARKER, markerContents(binding), {mode: 0o600, flag: 'wx'});
  const r = registry(binding);
  const rootStat = fs.lstatSync('/qualified');
  const fd = fs.openSync('/qualified', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    report.actualMountBoundary = {
      namespaceMount: JSON.parse(mount.fingerprint), dev: rootStat.dev, ino: rootStat.ino,
      fdMountId: fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^mnt_id:\s+(\d+)/m)?.[1],
      diagnostic: r.inspect(binding.id, true), scope: 'disposable tmpfs, not physical SSD qualification',
    };
  } finally { fs.closeSync(fd); }
  assert.equal(report.actualMountBoundary.diagnostic.capabilities.write, true);
  assert.throws(() => r.openSecure(binding.id), /Secure descriptor/);
  // A new registry re-enrolls a correctly labelled replacement marker: no durable provenance.
  r.close();
  fs.unlinkSync('/qualified/' + IDENTITY_MARKER);
  fs.writeFileSync('/qualified/' + IDENTITY_MARKER, markerContents(binding), {mode: 0o600});
  report.markerRestartReenrollment = registry(binding).inspect(binding.id);
  assert.equal(report.markerRestartReenrollment.state, 'online');
  const empty = path.join(scratch, 'underlying-empty'); fs.mkdirSync(empty);
  const missing = path.join(scratch, 'absent');
  const emptyResult = registry({...binding, root: empty}).inspect(binding.id, true);
  const missingResult = registry({...binding, root: missing}).inspect(binding.id, true);
  assert.equal(emptyResult.state, 'offline'); assert.equal(missingResult.state, 'offline');
  assert.deepEqual(fs.readdirSync(empty), []); assert.equal(fs.existsSync(missing), false);
  report.absentAndEmptyUnderlying = {emptyResult, missingResult, rootsCreated: false, bytesWritten: 0};
  const extra = {...binding, id: 'a2e8a3b0-8d57-4c49-9f8c-0d095b344602', machineKey: 'ssd-workspace', mountKey: 'ssd-workspace', profile: 'blocked'};
  for (const old of registries) old.close();
  fs.writeFileSync('/qualified/' + IDENTITY_MARKER, markerContents(extra), {mode: 0o600});
  const extraRegistry = registry(extra);
  report.additionalMount = extraRegistry.inspect(extra.id, true);
  assert.equal(report.additionalMount.reason, 'secure-open-unavailable');
  assert.equal(report.additionalMount.capabilities.write, false);
  assert.equal(report.additionalMount.capabilities.read, false);
  assert.throws(() => extraRegistry.assertAccess(extra.id, true));
  assert.throws(() => registry({...extra, profile: 'trusted-legacy'}));
  const input = path.join(scratch, 'cross-fs-input'); fs.writeFileSync(input, Buffer.from([0,255,128,1]));
  let exdev;
  try { fs.renameSync(input, '/qualified/exdev-output'); } catch (error) { exdev = error.code; }
  assert.equal(exdev, 'EXDEV'); assert.equal(fs.existsSync('/qualified/exdev-output'), false);
  assert.deepEqual(fs.readFileSync(input), Buffer.from([0,255,128,1]));
  report.actualExdev = {code: exdev, sourcePreserved: true, destinationCreated: false, scope: 'kernel rename primitive; service no-copy behavior requires separate tests'};

  // Deterministic scheduling barrier in actual Multer guard-to-open gap.
  // Both the apparent root and escaped destination belong to this private scratch.
  const storageRoot = path.join(scratch, 'legacy'); fs.mkdirSync(storageRoot);
  const resolver = makeResolver(storageRoot);
  const ingress = resolver.ingress(LEGACY_UPLOAD_WORKSPACE); fs.mkdirSync(ingress);
  const outside = path.join(scratch, 'attacker-owned'); fs.mkdirSync(outside);
  const preserved = path.join(storageRoot, '.tmp', 'preserved-ingress');
  let target;
  const engine = abortableDiskStorage(ingress, p => {
    resolver.assertPath(p);
    target = p;
    fs.renameSync(ingress, preserved);
    fs.symlinkSync(outside, ingress);
  });
  const request = new EventEmitter(); request.res = new EventEmitter();
  const bytes = Buffer.from([0,255,128,0,1]);
  await new Promise((resolve, reject) => engine._handleFile(request, {stream: Readable.from(bytes)}, (error, file) => error ? reject(error) : resolve(file)));
  assert.deepEqual(fs.readFileSync(path.join(outside, path.basename(target))), bytes);
  report.legacyToctouDisqualifier = {
    interleaving: 'real guard completes -> ingress ancestor replaced by symlink -> actual Multer pathname writer opens',
    escapedScratchWriteObserved: true, fixtureBytes: bytes.length,
    securityResult: 'FAIL: not TOCTOU-safe; excludes additional activation',
  };
  // Resolver startup repins a substituted workspace; current legacy profile never promised restart provenance.
  fs.unlinkSync(ingress); fs.renameSync(preserved, ingress);
  resolver.root(LEGACY_UPLOAD_WORKSPACE); resolver.close();
  const oldRoot = path.join(storageRoot, 'saved-workspace');
  fs.renameSync(path.join(storageRoot, '.tmp'), oldRoot); fs.mkdirSync(path.join(storageRoot, '.tmp'));
  report.workspaceRestartDisqualifier = {newResolverAcceptedReplacement: makeResolver(storageRoot).root(LEGACY_UPLOAD_WORKSPACE) === path.join(storageRoot, '.tmp'), securityResult: 'FAIL: no durable workspace identity'};
  assert.equal(report.workspaceRestartDisqualifier.newResolverAcceptedReplacement, true);
  report.physicalMountRemovalRemount = 'UNQUALIFIED: no host disk or privileged mount mutation performed';
  report.originalUserBytesMoved = 0;
})().then(() => {
  for (const resolver of resolvers) resolver.close();
  for (const service of services) service.onModuleDestroy();
  for (const r of registries) r.close();
  fs.rmSync(scratch, {recursive: true, force: true});
  report.cleanup = 'scratch removed; tmpfs removed with disposable container';
  console.log(JSON.stringify(report, null, 2));
}).catch(error => {
  for (const resolver of resolvers) resolver.close();
  for (const service of services) service.onModuleDestroy();
  for (const r of registries) r.close();
  fs.rmSync(scratch, {recursive: true, force: true});
  console.error(error); process.exitCode = 1;
});
