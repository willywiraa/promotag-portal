/*
 * Whether a visitor sits at the VM itself: only then may the first portal login be created.
 * "The VM itself" means any of its own addresses (loopback or a network adapter's), so opening the
 * portal on the VM by its IP counts too. Behind IIS every request arrives from the VM, so then the
 * visitor is the last X-Forwarded-For entry, the one IIS added. That header only counts when the
 * request comes from the VM, so another PC can't fake it.
 */
'use strict';
const os = require('os');

/** "10.1.2.3:51234" / "[::1]:51234" / "::ffff:10.1.2.3" -> "10.1.2.3" / "::1" / "10.1.2.3" */
function addressOnly(s) {
  let v = String(s || '').trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (v6) v = v6[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.replace(/:\d+$/, '');
  return v.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase();
}

/** Loopback plus every network adapter's address, read each time (an address can change). */
function ownAddresses() {
  const own = new Set(['127.0.0.1', '::1']);
  Object.values(os.networkInterfaces()).flat().forEach((i) => i && own.add(addressOnly(i.address)));
  return own;
}

function isLocal(req, own = ownAddresses()) {
  if (!own.has(addressOnly(req.socket.remoteAddress))) return false;
  const forwarded = req.headers['x-forwarded-for'];
  return !forwarded || own.has(addressOnly(String(forwarded).split(',').pop()));
}

module.exports = { isLocal, addressOnly, ownAddresses };
