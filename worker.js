'use strict';

const { workerData, parentPort } = require('worker_threads');
const crypto = require('crypto');

const endAt = Date.now() + (workerData?.durationMs || 30000);

// Tight CPU loop: hash random bytes until time is up. Yields periodically
// so the worker can still respond to termination signals.
(function burn() {
  const deadline = Date.now() + 50; // 50ms slice
  while (Date.now() < deadline) {
    crypto.createHash('sha256').update(crypto.randomBytes(1024)).digest('hex');
  }
  if (Date.now() < endAt) {
    setImmediate(burn);
  } else {
    parentPort?.postMessage({ done: true });
    process.exit(0);
  }
})();
