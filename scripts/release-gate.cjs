#!/usr/bin/env node
// These checks report their narrow scope; they do not authorize public traffic.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
  const mode = process.argv[2];
  if (mode === 'config') {
    if (process.env.NODE_ENV !== 'production') throw Error('production mode required');
    require(path.join(root,'backend/dist/common/production-config.js')).validateProductionConfig(process.env);
    console.log('PRODUCTION_CONFIG: PASS (syntax and baseline; secret lifecycle remains separate evidence)');
  } else if (mode === 'artifact') {
    if (cp.execFileSync('git', ['diff', '--name-only', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()) throw Error('tracked changes present');
    for (const file of ['backend/dist/main.js','backend/dist/data-source.js','frontend/dist/index.html']) if (!fs.existsSync(path.join(root,file))) throw Error('missing build artifact: '+file);
    const migrations = fs.readdirSync(path.join(root,'backend/dist/migrations')).filter(f=>f.endsWith('.js'));
    if (!migrations.length) throw Error('missing compiled migrations');
    console.log('ARTIFACT_INPUTS: PASS (presence and tracked cleanliness; build provenance remains release evidence)');
  } else if (mode === 'migrations') {
    const source = require(path.join(root,'backend/dist/data-source.js')).default;
    try { await source.initialize(); if (await source.showMigrations()) throw Error('pending migrations'); console.log('MIGRATIONS_APPLIED: PASS'); }
    finally { if (source.isInitialized) await source.destroy(); }
  } else if (mode === 'runtime') {
    const base=process.env.RELEASE_BASE_URL;
    if (!base) throw Error('RELEASE_BASE_URL required');
    for(const endpoint of ['health/live','health/ready']) {
      const res=await fetch(base.replace(/\/$/,'')+'/api/v1/'+endpoint,{signal:AbortSignal.timeout(10000)});
      if(res.status!==200) throw Error(endpoint+' unhealthy');
    }
    const denied=await fetch(base.replace(/\/$/,'')+'/api/v1/metrics',{signal:AbortSignal.timeout(10000)});
    if (![401,404].includes(denied.status)) throw Error('metrics accessible without token');
    console.log('RUNTIME_HEALTH_METRICS: PASS (backup, smoke, rollback and public TLS acceptance remain separate blocking evidence)');
  } else throw Error('usage: release-gate.cjs config|artifact|migrations|runtime');
}
main().catch(()=>{console.error('RELEASE_GATE: FAIL (check mode inputs and protected logs; secrets suppressed)');process.exitCode=1;});
