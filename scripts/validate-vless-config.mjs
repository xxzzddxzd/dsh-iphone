#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_ACCESS_LOG = '/var/root/dsh-vless-access.log';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function containsPlaceholder(value) {
  if (typeof value === 'string') return value.includes('REPLACE_');
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsPlaceholder);
  }
  return false;
}

export function validateVlessConfig(config, options = {}) {
  const proxyPort = options.proxyPort ?? 18080;
  const allowPlaceholders = options.allowPlaceholders ?? false;

  assert(config && typeof config === 'object' && !Array.isArray(config),
    'top-level configuration must be an object');
  assert(config.log?.access === REQUIRED_ACCESS_LOG,
    `log.access must be ${REQUIRED_ACCESS_LOG}`);
  assert(Array.isArray(config.inbounds) && config.inbounds.length === 1,
    'configuration must contain exactly one inbound');

  const inbound = config.inbounds[0];
  assert(inbound.tag === 'dsh-http', 'inbound tag must be dsh-http');
  assert(inbound.listen === '127.0.0.1',
    'inbound must listen only on 127.0.0.1');
  assert(inbound.port === proxyPort,
    `inbound port must be ${proxyPort}`);
  assert(inbound.protocol === 'http', 'inbound protocol must be http');

  assert(Array.isArray(config.outbounds) && config.outbounds.length >= 1,
    'configuration must contain at least one outbound');
  const vless = config.outbounds[0];
  assert(vless.tag === 'vless-out', 'first outbound tag must be vless-out');
  assert(vless.protocol === 'vless', 'first outbound protocol must be vless');
  assert(!config.outbounds.some((outbound) => outbound?.protocol === 'freedom'),
    'freedom outbound is forbidden by fail-closed policy');

  const servers = vless.settings?.vnext;
  assert(Array.isArray(servers) && servers.length === 1,
    'vless-out must contain exactly one vnext server');
  assert(typeof servers[0].address === 'string' && servers[0].address.length > 0,
    'VLESS server address is required');
  assert(Number.isInteger(servers[0].port) && servers[0].port > 0 && servers[0].port <= 65535,
    'VLESS server port must be between 1 and 65535');
  assert(Array.isArray(servers[0].users) && servers[0].users.length >= 1,
    'at least one VLESS user is required');
  assert(typeof servers[0].users[0].id === 'string' && servers[0].users[0].id.length > 0,
    'VLESS user id is required');

  if (!allowPlaceholders) {
    assert(!containsPlaceholder(config),
      'configuration still contains a REPLACE_ placeholder');
  }

  return config;
}

function parseArguments(argv) {
  const options = { allowPlaceholders: false, proxyPort: 18080, file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-placeholders') {
      options.allowPlaceholders = true;
    } else if (argument === '--port') {
      index += 1;
      options.proxyPort = Number(argv[index]);
    } else if (!options.file) {
      options.file = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }
  assert(options.file, 'usage: validate-vless-config.mjs [--allow-placeholders] [--port PORT] CONFIG');
  assert(Number.isInteger(options.proxyPort), 'proxy port must be an integer');
  return options;
}

export function validateVlessConfigFile(file, options = {}) {
  const source = fs.readFileSync(file, 'utf8');
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
  return validateVlessConfig(config, options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    validateVlessConfigFile(options.file, options);
    process.stdout.write(`VLESS configuration is valid: ${fileURLToPath(pathToFileURL(path.resolve(options.file)))}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
