#!/usr/bin/env node
// Remove Cline plugin entries from a stopped profile; package removal follows separately.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const [profileArg, runtimeArg, mode] = process.argv.slice(2);
if (!profileArg || !runtimeArg || !['--audit', '--apply'].includes(mode)) throw new Error('usage: remove-cline-profile.mjs <profile> <runtime> --audit|--apply');
const profile = resolve(profileArg);
const yaml = createRequire(resolve(runtimeArg, 'package.json'))('js-yaml');
const names = new Set(['dsh-cline-pass', 'dsh-clinepass']);
const ids = new Set(['cline-pass', 'clinepass']);
const packageFile = join(profile, 'package.json');
const patchFile = join(profile, 'cordis.patch.yml');
const beforePackage = await readFile(packageFile, 'utf8');
const beforePatch = await readFile(patchFile, 'utf8');
const pkg = JSON.parse(beforePackage);
const bundles = pkg.dsh?.profile?.bundles;
if (!Array.isArray(bundles) || bundles.some(x => typeof x !== 'string')) throw new Error('Invalid profile bundle list');
const rows = yaml.load(beforePatch);
if (!Array.isArray(rows)) throw new Error('Invalid profile patch');
const remaining = rows.filter(row => !ids.has(row?.id) && !names.has(row?.name));
pkg.dsh.profile.bundles = bundles.filter(name => !names.has(name));
const dependencies = [...names].filter(name => Object.hasOwn(pkg.dependencies ?? {}, name));
const nextPatch = yaml.dump(remaining, { noRefs: true, lineWidth: -1 });
if (!isDeepStrictEqual(yaml.load(nextPatch), remaining)) throw new Error('Profile YAML did not round-trip');
const changed = remaining.length !== rows.length || pkg.dsh.profile.bundles.length !== bundles.length;
if (mode === '--apply' && changed) {
  const backup = join(profile, '.migration-backups', `remove-cline-${randomUUID()}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(join(backup, 'package.json'), beforePackage, { mode: 0o600, flag: 'wx' });
  await writeFile(join(backup, 'cordis.patch.yml'), beforePatch, { mode: 0o600, flag: 'wx' });
  if (await readFile(packageFile, 'utf8') !== beforePackage || await readFile(patchFile, 'utf8') !== beforePatch) throw new Error('Profile changed during removal');
  for (const [file, contents] of [[packageFile, JSON.stringify(pkg, null, 2) + '\n'], [patchFile, nextPatch]]) {
    const temp = file + '.remove-cline-' + randomUUID();
    await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }
}
console.log(JSON.stringify({ status: changed ? mode === '--apply' ? 'applied' : 'planned' : 'current', removedRows: rows.length - remaining.length, dependencies }));
