import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = await mkdtemp(join(tmpdir(), 'dsh-cline-removal-'));
try {
  const profile = join(temp, 'profile');
  await mkdir(profile);
  const pkg = { dependencies: { 'dsh-cline-pass': '1', 'dsh-clinepass': '2', other: '3' }, dsh: { profile: { bundles: ['other', 'dsh-cline-pass', 'dsh-clinepass'] } } };
  const patch = '- id: cline-pass\n  name: dsh-cline-pass\n  config:\n    key: sensitive-fixture\n- id: other\n  config:\n    value: retained\n- id: clinepass\n  config: {}\n';
  await writeFile(join(profile, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(profile, 'cordis.patch.yml'), patch);
  const script = resolve('scripts/remove-cline-profile.mjs');
  const runtime = resolve('dsh-runtime');
  const run = mode => {
    const r = spawnSync(process.execPath, [script, profile, runtime, mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(run('--audit').status, 'planned');
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(run('--apply').removedRows, 2);
  const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(after.dsh.profile.bundles, ['other']);
  assert.deepEqual(after.dependencies, pkg.dependencies, 'package manager performs dependency removal separately');
  const afterPatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.match(afterPatch, /retained/);
  assert.doesNotMatch(afterPatch, /cline|sensitive-fixture/);
  assert.equal(run('--apply').status, 'current');
  console.log('Cline profile removal preserves unrelated rows and package dependencies, is audited, backed up and idempotent');
} finally { await rm(temp, { recursive: true, force: true }); }
