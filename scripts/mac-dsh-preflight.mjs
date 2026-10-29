/** In-process launchd preflight, loaded by Node --import before the DSH Web CLI. */
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { patchPurgeManagedRestart } from './patch-mac-dsh-purge.mjs';

async function prepareManagedWeb() {
  if (process.env.DSH_MANAGED_RESTART !== 'launchd') {
    throw new Error('this entry point requires DSH_MANAGED_RESTART=launchd from its LaunchAgent');
  }
  if (process.argv.length !== 4 || process.argv[2] !== 'web' || process.argv[3] !== '--no-open') {
    throw new Error('the managed entry point must be DSH web --no-open; other profiles and arguments are not accepted');
  }
  const expected = resolve(process.env.DSH_MAC_DSH_BIN || '/opt/homebrew/bin/dsh');
  const actual = process.argv[1];
  if (!actual || await realpath(actual) !== await realpath(expected) || !(await stat(expected)).isFile()) {
    throw new Error('the managed entry point does not match the selected DSH CLI');
  }
  await access(expected, constants.R_OK);

  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  process.env.DSH_HOME = dshHome;
  process.env.DSH_PROFILE = 'web';
  const purgeRoot = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-purge');
  let installed = false;
  try {
    await lstat(purgeRoot);
    installed = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let purgeStatus = 'absent';
  if (installed) {
    try {
      await access(join(purgeRoot, 'package.json'), constants.R_OK);
    } catch {
      throw new Error('the installed Purge package is incomplete');
    }
    const result = await patchPurgeManagedRestart(purgeRoot);
    purgeStatus = result.status;
  }
  return { pid: process.pid, dshHome, profile: 'web', purgeStatus };
}

let result;
try {
  result = await prepareManagedWeb();
} catch (error) {
  console.error(`Mac DSH preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
export const macDshPreflight = result;
