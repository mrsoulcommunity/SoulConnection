'use strict';
// Port allocation. The interesting cases are all collisions, and they are hard
// to hit by hand on a developer machine (they need something else to already
// hold the preferred port) -- which is exactly why they went unnoticed.
const test = require('node:test');
const assert = require('node:assert');
const { allocatePorts, DISPATCH_PORT_BASE } = require('../electron/vpn/ports.cjs');

// Stand-in for lib/freePort.cjs: every port in `busy` is taken, and the search
// walks upwards from the preferred one exactly as the real thing does.
function fakeFinder(busy = []) {
  const taken = new Set(busy);
  return async (preferred) => {
    let port = preferred;
    while (taken.has(port)) port++;
    return port;
  };
}

const settings = { socksPort: 10808, httpPort: 10809 };

test('hands out the preferred ports when nothing is in the way', async () => {
  const ports = await allocatePorts({ settings, findFreePort: fakeFinder() });
  assert.equal(ports.socksPort, 10808);
  assert.equal(ports.httpPort, 10809);
  assert.equal(ports.apiPort, 10810);
  assert.equal(ports.dispatch, null);
});

test('a busy SOCKS port never steals the HTTP port', async () => {
  // 10808 taken -> SOCKS bumps to 10809, which is what HTTP wanted.
  const ports = await allocatePorts({ settings, findFreePort: fakeFinder([10808]) });
  assert.equal(ports.socksPort, 10809);
  assert.notEqual(ports.httpPort, ports.socksPort);
  assert.notEqual(ports.apiPort, ports.httpPort);
});

test('every port is distinct even when a whole block is reserved', async () => {
  // Hyper-V, WSL and Docker reserve blocks thousands of ports wide.
  const block = [];
  for (let p = 10808; p < 10815; p++) block.push(p);
  const ports = await allocatePorts({ settings, findFreePort: fakeFinder(block) });
  const all = [ports.socksPort, ports.httpPort, ports.apiPort];
  assert.equal(new Set(all).size, 3);
  for (const p of all) assert.ok(!block.includes(p));
});

test('the four dispatcher ports never collide with each other', async () => {
  // The bug this covers: each was requested independently, so a busy base port
  // handed the same replacement to two of them -- two inbounds on one port, and
  // xray refusing the config.
  const ports = await allocatePorts({
    settings,
    useDispatcher: true,
    findFreePort: fakeFinder([DISPATCH_PORT_BASE]),
  });
  const all = [
    ports.socksPort, ports.httpPort, ports.apiPort,
    ports.dispatch.proxySocks, ports.dispatch.proxyHttp,
    ports.dispatch.directSocks, ports.dispatch.directHttp,
  ];
  assert.equal(new Set(all).size, all.length, `duplicate port in ${all.join(',')}`);
});

test('an OS-assigned ephemeral port that duplicates an earlier pick is rejected', async () => {
  // findFreePort's last resort asks the OS for any free port, which knows
  // nothing about what this allocation has already handed out.
  let call = 0;
  const finder = async () => {
    call++;
    return call <= 2 ? 30000 : 30000 + call; // twice the same answer
  };
  const ports = await allocatePorts({ settings, findFreePort: finder });
  assert.notEqual(ports.httpPort, ports.socksPort);
});

test('falls back to the standard ports when settings carry none', async () => {
  const ports = await allocatePorts({ settings: {}, findFreePort: fakeFinder() });
  assert.equal(ports.socksPort, 10808);
  assert.equal(ports.httpPort, 10809);
});

test('refuses to run without a port finder', async () => {
  await assert.rejects(() => allocatePorts({ settings }), /findFreePort/);
});
