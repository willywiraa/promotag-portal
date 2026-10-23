/*
 * Who counts as "on the VM itself" (lib/visitor.js): only they may create the first portal login.
 * The VM here has the address 10.101.32.163. Run: npm test
 */
'use strict';
const assert = require('assert');
const { isLocal, addressOnly } = require('../lib/visitor');

const own = new Set(['127.0.0.1', '::1', '10.101.32.163']);
const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

const cases = [
  ['the VM itself, directly', req('127.0.0.1'), true],
  ['the VM itself over IPv6', req('::1'), true],
  ['the VM by its own IP (IPv4 in IPv6 form)', req('::ffff:10.101.32.163'), true],
  ['another PC, directly', req('10.0.0.5'), false],
  ['another PC with a faked X-Forwarded-For', req('10.0.0.5', '127.0.0.1'), false],
  ['a colleague through IIS', req('127.0.0.1', '10.0.0.5:51234'), false],
  ['someone at the VM through IIS, by localhost', req('::1', '[::1]:51234'), true],
  ['someone at the VM through IIS, by its IP', req('127.0.0.1', '10.101.32.163:51234'), true],
  ['a colleague who sent a fake header through IIS', req('127.0.0.1', '127.0.0.1, 10.0.0.5:51234'), false],
];

let failed = 0;
for (const [name, r, expected] of cases) {
  try {
    assert.strictEqual(isLocal(r, own), expected);
    console.log(`PASS  ${name}`);
  } catch (_) {
    failed++;
    console.log(`FAIL  ${name}: expected ${expected}`);
  }
}
try {
  assert.deepStrictEqual(['10.1.2.3:51234', '[::1]:5', '::ffff:10.1.2.3', 'FE80::1'].map(addressOnly), ['10.1.2.3', '::1', '10.1.2.3', 'fe80::1']);
  console.log('PASS  addresses are read with or without port and IPv6 form');
} catch (err) {
  failed++;
  console.log(`FAIL  addresses: ${err.message}`);
}
console.log(failed ? `\n${failed} failed` : `\n${cases.length + 1}/${cases.length + 1} passed`);
process.exitCode = failed ? 1 : 0;
