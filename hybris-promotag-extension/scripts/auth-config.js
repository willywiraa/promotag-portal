/*
 * Portal login configuration.
 *
 * users: credential records generated with dev/tools/credential-hasher.html, e.g.
 *   { userId: 'ops.user', salt: '…', hash: '…', iterations: 600000, algo: 'PBKDF2-SHA256' }
 * When the list is empty, the first popup open offers a one-time "Create portal login"
 * whose hashed credential is stored in chrome.storage.local.
 *
 * Use a portal-specific access key here, not your real IT/AD password.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  PTAE.AUTH_CONFIG = {
    sessionTtlMinutes: 480,
    users: [],
  };
})(globalThis);
