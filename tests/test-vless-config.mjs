import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateVlessConfig } from '../scripts/validate-vless-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = JSON.parse(fs.readFileSync(
  path.join(root, 'config/xray/vless-ws-tls.json.example'),
  'utf8',
));

assert.doesNotThrow(() => validateVlessConfig(example, {
  allowPlaceholders: true,
  proxyPort: 18080,
}));

const complete = structuredClone(example);
complete.outbounds[0].settings.vnext[0].address = 'vless.example.com';
complete.outbounds[0].settings.vnext[0].users[0].id = '11111111-1111-1111-1111-111111111111';
complete.outbounds[0].streamSettings.tlsSettings.serverName = 'vless.example.com';
complete.outbounds[0].streamSettings.wsSettings.path = '/vless';
complete.outbounds[0].streamSettings.wsSettings.headers.Host = 'vless.example.com';
assert.doesNotThrow(() => validateVlessConfig(complete));

const exposed = structuredClone(complete);
exposed.inbounds[0].listen = '0.0.0.0';
assert.throws(() => validateVlessConfig(exposed), /127\.0\.0\.1/);

const wrongPort = structuredClone(complete);
wrongPort.inbounds[0].port = 1080;
assert.throws(() => validateVlessConfig(wrongPort), /18080/);

const failOpen = structuredClone(complete);
failOpen.outbounds.push({ tag: 'direct', protocol: 'freedom' });
assert.throws(() => validateVlessConfig(failOpen), /freedom/);

assert.throws(() => validateVlessConfig(example), /REPLACE_/);

process.stdout.write('VLESS configuration validation tests passed\n');
