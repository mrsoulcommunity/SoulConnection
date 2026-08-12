'use strict';
// Bringing a tunnel up and down, against fakes for the three things that touch
// the OS. What is being pinned here is ordering and rollback: the failures this
// covers are the ones that leave a machine with no internet at all.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Tunnel } = require('../electron/vpn/tunnel.cjs');

function makeFakes({ dispatcherFails = false, tunFails = false } = {}) {
  const calls = [];
  const xray = new EventEmitter();
  xray.running = false;
  xray.starts = [];
  xray.start = async (config) => { calls.push('xray.start'); xray.starts.push(config); xray.running = true; };
  xray.stop = async () => { calls.push('xray.stop'); xray.running = false; };

  const tunNetwork = {
    applied: null,
    apply: async (opts) => {
      calls.push('tun.apply');
      if (tunFails) throw new Error('netsh refused');
      tunNetwork.applied = opts;
    },
    teardown: async () => { calls.push('tun.teardown'); tunNetwork.applied = null; },
  };

  const dispatcherHost = {
    active: false,
    start: async () => {
      calls.push('dispatcher.start');
      if (dispatcherFails) throw new Error('EADDRINUSE');
      dispatcherHost.active = true;
    },
    stop: async () => { calls.push('dispatcher.stop'); dispatcherHost.active = false; },
  };

  return { calls, xray, tunNetwork, dispatcherHost };
}

function makeTunnel(fakes) {
  return new Tunnel({
    xray: fakes.xray,
    tunNetwork: fakes.tunNetwork,
    dispatcherHost: fakes.dispatcherHost,
    buildConfig: (profile, opts) => ({ profile: profile.id, opts }),
    tunConfig: {
      name: 'soulconnection-tun',
      address: '10.90.90.2',
      prefixLength: 24,
      gateway: '10.90.90.1',
      dnsServers: ['1.1.1.1'],
    },
  });
}

const profile = { id: 'p1', name: 'Tokyo', address: 'example.com', port: 443, protocol: 'vless' };
const settings = { xrayLogLevel: 'warning', socksHost: '127.0.0.1', httpHost: '127.0.0.1' };
const ports = { socksPort: 10808, httpPort: 10809, apiPort: 10810 };
const dispatchPorts = {
  ...ports,
  dispatch: { proxySocks: 20808, proxyHttp: 20809, directSocks: 20810, directHttp: 20811 },
};
const plainRouting = { useDispatcher: false, rules: ['plain'], fallbackRules: ['plain'] };
const dispatchRouting = { useDispatcher: true, rules: ['dispatch'], fallbackRules: ['plain'] };

test('a plain session probes the port xray itself is listening on', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  const session = await tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting });

  assert.equal(session.profileId, 'p1');
  assert.equal(session.ports.probeHttpPort, session.ports.httpPort);
  assert.equal(session.dispatcherActive, false);
  assert.equal(tunnel.active, session);
  assert.deepEqual(fakes.calls, ['xray.start']);
  assert.ok(Object.isFrozen(session), 'a session is a value, not a mutable scratchpad');
});

test('with the dispatcher up, probes go to the private inbound', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  const session = await tunnel.open({
    profile, mode: 'proxy', settings, ports: dispatchPorts, routing: dispatchRouting,
  });

  assert.equal(session.ports.probeHttpPort, 20809);
  assert.equal(session.dispatcherActive, true);
  assert.deepEqual(fakes.calls, ['xray.start', 'dispatcher.start']);
});

test('a dispatcher that cannot bind falls back to the plain layout and says so', async () => {
  const fakes = makeFakes({ dispatcherFails: true });
  const tunnel = makeTunnel(fakes);
  const notices = [];
  tunnel.on('notice', (n) => notices.push(n));

  const session = await tunnel.open({
    profile, mode: 'proxy', settings, ports: dispatchPorts, routing: dispatchRouting,
  });

  // The public ports are what the rest of the machine talks to; a running
  // tunnel nobody can reach would be worse than losing the per-app rules.
  assert.deepEqual(fakes.calls, [
    'xray.start', 'dispatcher.start', 'dispatcher.stop', 'xray.stop', 'xray.start',
  ]);
  assert.deepEqual(fakes.xray.starts[1].opts.routingRules, ['plain']);
  assert.equal(session.dispatcherActive, false);
  assert.equal(session.ports.probeHttpPort, 10809);
  assert.equal(notices.length, 1);
});

test('tunnel mode configures the adapter and pins the server address', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  await tunnel.open({ profile, mode: 'tun', settings, ports, routing: plainRouting });

  assert.deepEqual(fakes.calls, ['xray.start', 'tun.apply']);
  assert.equal(fakes.tunNetwork.applied.serverAddress, 'example.com');
  assert.equal(fakes.tunNetwork.applied.adapterName, 'soulconnection-tun');
});

test('a failure after the routes go in leaves nothing behind', async () => {
  const fakes = makeFakes({ tunFails: true });
  const tunnel = makeTunnel(fakes);

  await assert.rejects(
    () => tunnel.open({ profile, mode: 'tun', settings, ports, routing: plainRouting }),
    /netsh refused/
  );

  // Routes must come out even when the failure happened after they went in, and
  // a surviving xray would make every later connect fail with "already running".
  assert.deepEqual(fakes.calls, ['xray.start', 'tun.apply', 'dispatcher.stop', 'tun.teardown', 'xray.stop']);
  assert.equal(tunnel.active, null);
  assert.equal(fakes.xray.running, false);
});

test('a failed open does not report itself as a drop', async () => {
  const fakes = makeFakes({ tunFails: true });
  const tunnel = makeTunnel(fakes);
  let dropped = 0;
  tunnel.on('dropped', () => { dropped++; });

  // The rollback stops xray, and a stopping process emits `exit`.
  fakes.xray.stop = async () => { fakes.xray.emit('exit', 0); };
  await assert.rejects(() => tunnel.open({ profile, mode: 'tun', settings, ports, routing: plainRouting }));
  assert.equal(dropped, 0);
});

test('an unexpected exit is a drop, and carries the session it killed', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  const session = await tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting });

  const drops = [];
  tunnel.on('dropped', (s) => drops.push(s));
  fakes.xray.emit('exit', 1);

  assert.deepEqual(drops, [session]);
  assert.equal(tunnel.active, null, 'the session is over the moment it dropped');
});

test('closing deliberately is never mistaken for a crash', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  await tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting });

  let dropped = 0;
  tunnel.on('dropped', () => { dropped++; });
  // A real xray emits `exit` from inside stop().
  fakes.xray.stop = async () => { fakes.calls.push('xray.stop'); fakes.xray.emit('exit', 0); };

  await tunnel.close();
  assert.equal(dropped, 0, 'no expectedExit flag to forget to set');
  assert.equal(tunnel.active, null);
  // The dispatcher must stop before xray, and routes must come out before the
  // adapter disappears.
  assert.deepEqual(fakes.calls, ['xray.start', 'dispatcher.stop', 'tun.teardown', 'xray.stop']);
});

test('a second exit after the session ended changes nothing', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  await tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting });
  let dropped = 0;
  tunnel.on('dropped', () => { dropped++; });

  fakes.xray.emit('exit', 1);
  fakes.xray.emit('exit', 1);
  assert.equal(dropped, 1, 'a stale exit cannot be attributed to a session that no longer exists');
});

test('cleanup after a drop does not try to stop a process that is already gone', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  await tunnel.open({ profile, mode: 'tun', settings, ports, routing: plainRouting });
  fakes.xray.emit('exit', 1);
  fakes.calls.length = 0;

  await tunnel.cleanupAfterDrop();
  assert.deepEqual(fakes.calls, ['dispatcher.stop', 'tun.teardown']);
});

test('opening twice without closing is refused', async () => {
  const fakes = makeFakes();
  const tunnel = makeTunnel(fakes);
  await tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting });
  await assert.rejects(
    () => tunnel.open({ profile, mode: 'proxy', settings, ports, routing: plainRouting }),
    /already open/
  );
});
