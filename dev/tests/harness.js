/*
 * Minimal in-page test harness. Results are written into the DOM so run-tests.ps1 can read them
 * from `chrome --headless --dump-dom`: <body data-status="pass|fail" data-total data-failed> and
 * <pre id="ptae-test-results">.
 */
(function () {
  'use strict';
  const tests = [];
  const errors = [];

  window.addEventListener('error', (e) => errors.push(`Uncaught: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`Unhandled rejection: ${e.reason && e.reason.stack ? e.reason.stack : e.reason}`));

  window.test = (name, fn) => tests.push({ name, fn });

  window.assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'assertion failed');
  };

  window.assertEqual = (actual, expected, msg) => {
    if (actual !== expected) {
      throw new Error(`${msg || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  window.assertMatch = (actual, re, msg) => {
    if (!re.test(String(actual))) throw new Error(`${msg || 'no match'}: ${JSON.stringify(actual)} !~ ${re}`);
  };

  /*
   * Under --virtual-time-budget, virtual time jumps ahead whenever the page is idle, so real
   * asynchronous I/O (IndexedDB) can lose the race against the DOM dump. While such a suite runs,
   * keep the page busy with short real-time work so the virtual clock advances slowly.
   */
  function keepAlive() {
    let on = true;
    (function tick() {
      if (!on) return;
      let x = 0;
      for (let i = 0; i < 300000; i++) x += i % 7; // ~1–3 ms of real CPU time, clock-independent
      window.__keepAliveSink = x;
      setTimeout(tick, 1);
    })();
    return () => { on = false; };
  }

  window.runTests = async function runTests(opts = {}) {
    document.body.dataset.status = 'running';
    const stopKeepAlive = opts.realTimeIO ? keepAlive() : () => {};
    const lines = [];
    let failed = 0;
    for (const t of tests) {
      try {
        await t.fn();
        lines.push(`PASS  ${t.name}`);
      } catch (err) {
        failed++;
        const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : String(err);
        lines.push(`FAIL  ${t.name}\n        ${detail}`);
      }
    }
    stopKeepAlive();
    errors.forEach((e) => {
      failed++;
      lines.push(`FAIL  ${e}`);
    });
    const pre = document.getElementById('ptae-test-results') || document.body.appendChild(document.createElement('pre'));
    pre.id = 'ptae-test-results';
    pre.textContent = `${lines.join('\n')}\n\n${tests.length + errors.length - failed}/${tests.length + errors.length} passed`;
    document.body.dataset.total = String(tests.length + errors.length);
    document.body.dataset.failed = String(failed);
    document.body.dataset.status = failed ? 'fail' : 'pass';
  };
})();
