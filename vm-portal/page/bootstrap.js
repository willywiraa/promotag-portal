/*
 * Runs in a Backoffice page after the engine files (zk-bridge, zk-dom, selectors, content). It wires
 * the engine to the VM portal the way content.js's own bootstrap wires it to the extension:
 * messages to the portal go through the __ptaeVmSend binding, commands come back through
 * window.__ptaeVmCommand.
 */
(function (root) {
  'use strict';
  const PTAE = root.PTAE;
  if (!PTAE || !PTAE.createRunner || root.__ptaeVmCommand) return;

  const transport = {
    send(type, payload) {
      return Promise.resolve()
        .then(() => root.__ptaeVmSend(Object.assign({ type }, payload)))
        .catch(() => undefined);
    },
  };
  const runner = PTAE.createRunner({ transport, bridge: PTAE.dom.createBridgeClient() });

  root.__ptaeVmCommand = (msg) => {
    switch (msg && msg.type) {
      case 'BG_PING':
        return { ok: true, href: location.href };
      case 'BG_RUN':
        runner.run(msg.job);
        return { ok: true };
      case 'BG_ABORT':
        runner.abort(msg.reason);
        return { ok: true };
      case 'BG_CONFIRM':
        runner.confirm(!!msg.approve);
        return { ok: true };
      default:
        return null;
    }
  };

  transport.send('CS_READY', { href: location.href }).then((resp) => {
    if (resp && resp.job) runner.run(resp.job);
  });
})(globalThis);
