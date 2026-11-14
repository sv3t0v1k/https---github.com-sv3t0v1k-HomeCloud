// Verify the actual PR -> reusable qualification -> retained runtime graph.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('../../backend/node_modules/js-yaml');
const root = path.resolve(__dirname, '../..');
const read = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const caller = read('recovery-qualification.yml');
const workflow = read('ci.yml');

test('every PR revision reaches read-only exact-HEAD offline qualification', () => {
  const parent = read('ci-v2-fast.yml');
  assert.deepEqual(new Set(parent.on.pull_request.types), new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']));
  assert.deepEqual(Object.keys(parent.on.pull_request), ['types']);
  const invocation = parent.jobs['recovery-qualification'];
  assert.deepEqual(invocation, {
    if: "github.event_name == 'pull_request'",
    uses: './.github/workflows/recovery-qualification.yml',
    with: { source_sha: '${{ github.event.pull_request.head.sha }}' },
    permissions: { contents: 'read' },
  });
  assert.deepEqual(caller.on, { workflow_call: { inputs: { source_sha: { type: 'string', required: true } } } });
  assert.deepEqual(caller.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(caller.jobs), ['qualify']);
  const job = caller.jobs.qualify;
  assert.deepEqual(Object.keys(job).sort(), ['permissions', 'uses', 'with']);
  assert.equal(job.uses, './.github/workflows/ci.yml');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.deepEqual(job.with, {
    source_sha: '${{ inputs.source_sha }}',
    candidate_version: 'dry-run', qualification_profile: 'pull-request',
  });
});

test('native runtime tests use the retained candidate and mandatory aggregate gate', () => {
  const job = workflow.jobs['image-build'];
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['continue-on-error'], undefined);
  const build = job.steps.find(step => step.id === 'offline');
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, false);
  assert.match(build.with.outputs, /^type=oci,/);
  const runtime = job.steps.find(step => step.id === 'runtime');
  assert.match(runtime.run, /uname -s/);
  assert.match(runtime.run, /Linux\/x86_64/);
  assert.match(runtime.run, /host\['arch'\] in \('x86_64', 'amd64'\)/);
  assert.match(runtime.run, /host\['os'\] == 'linux'/);
  assert.match(runtime.run, /skopeo copy --override-os linux --override-arch amd64/);
  assert.match(runtime.run, /oci-scan-binding\.py.*--loaded-inspect/);
  const native = job.steps.find(step => step.name === 'Real copy recovery and maintenance admission on the production image');
  assert.match(native.run, /native-boundary-preflight\.cjs/);
  assert.match(native.run, /--strict/);
  assert.equal(native['continue-on-error'], undefined);
  const recovery = job.steps.find(step => step.name === 'Real Backup Restore in an isolated nested Docker daemon');
  const commands = recovery.run.split('\n').filter(line => line.includes('bash scripts/ci/run-restore-'));
  assert.equal(commands.length, 4);
  assert.ok(commands.every(line => line.includes('HOMECLOUD_E2E_BACKEND_IMAGE="homecloud-ci-backend:${{ github.sha }}"')));
  for (const mode of ['--encrypted-only', '--historical-schema-only', 'run-restore-fault-e2e-local.sh']) {
    assert.ok(commands.some(line => line.includes(mode)), mode);
  }
  assert.equal(recovery['continue-on-error'], undefined);
  for (const gate of ['gate', 'policy-coverage']) {
    assert.ok(workflow.jobs[gate].needs.includes('image-build'));
    assert.ok(workflow.jobs[gate].needs.includes('provenance-pair'));
  }
  assert.ok(workflow.jobs.gate.needs.includes('policy-coverage'));
});

test('existing required terminal status cannot pass before recovery qualification', () => {
  const gate = read('ci-v2-fast.yml').jobs['fast-integration-gate'];
  assert.equal(gate.name, 'ci-v2-fast-terminal');
  assert.equal(gate.if, 'always()');
  assert.ok(gate.needs.includes('recovery-qualification'));
  assert.equal(gate['continue-on-error'], undefined);
  const step = gate.steps.find(item => (item.run || '').includes('scripts/ci/ci-v2-fast-gate.py'));
  assert.equal(step.env.EVENT_NAME, '${{ github.event_name }}');
  assert.match(step.run, /--event-name "\$EVENT_NAME"/);
});

test('both PR fast tests and full qualification execute this routing regression', () => {
  for (const name of ['ci-v2-fast.yml', 'ci.yml']) {
    const runs = read(name).jobs['pr-fast-backend'].steps.map(step => step.run || '').join('\n');
    assert.match(runs, /node --test scripts\/ci\/test-recovery-workflow\.cjs/);
  }
});
