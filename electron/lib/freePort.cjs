'use strict';
const net = require('net');

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

// Asks the OS for any free port. Binding port 0 is the one method that cannot
// be wrong about it, which is what makes it the right last resort.
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.once('listening', () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });
    tester.listen(0, '127.0.0.1');
  });
}

async function findFreePort(preferredPort) {
  if (await isPortFree(preferredPort)) return preferredPort;
  for (let port = preferredPort + 1; port < preferredPort + 200; port++) {
    if (await isPortFree(port)) return port;
  }

  // Walking upwards runs out on a machine where a driver has reserved a whole
  // block -- Hyper-V, WSL and Docker all do this, and the reservations are
  // thousands of ports wide, so the 200-port window can land entirely inside
  // one. Every bind in it fails with EACCES and this used to throw, taking out
  // server testing and, when the configured proxy port was busy, connecting at
  // all. The OS can always name a port that works; ask it rather than give up.
  try {
    return await ephemeralPort();
  } catch {
    throw new Error('هیچ پورت آزادی برای اجرای پروکسی پیدا نشد');
  }
}

module.exports = { findFreePort };
