'use strict';
// The coordination layer, against fakes for everything that touches the OS.
//
// This is where the races used to live, so this is the file that pins them
// down: a disconnect issued while a selection sweep is running, a user
// disconnecting during an auto-reconnect's countdown, a failed sweep over a
// tunnel that never died.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { VpnCore } = require('../electron/vpn/core.cjs');
const { ConnectionMachine, Activity } = require('../electron/vpn/machine.cjs');
const { ReconnectPolicy } = require('../electron/vpn/reconnect.cjs');
const { createSession } = require('../electron/vpn/session.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore(data = {}) {
  const state = { profiles: [], activeProfileId: null, connectionMode: 'proxy', ...data };
  return {
    data: state,
    get: (k, d) => (k in state ? state[k] : d),
    set: (k, v) => { state[k] = v; },
  };
}

function makeCore(overrides = {}) {
  const calls = [];
  const profiles = [
    { id: 'a', name: 'Alpha', address: 'a.example', port: 443 },
    { id: 'b', name: 'Beta', address: 'b.example', port: 443 },
  ];

  const tunnel = new EventEmitter();
  tunnel.active = null;
  tunnel.openDelayMs = 0;
  tunnel.failWith = null;
  tunnel.open = async ({ profile, mode }) => {
    calls.push(`open:${profile.id}`);
    if (tunnel.openDelayMs) await sleep(tunnel.openDelayMs);
    if (tunnel.failWith) throw new Error(tunnel.failWith);
    tunnel.active = createSession({
      profileId: profile.id,
      profileName: profile.name,
      mode,
      ports: { socksPort: 1080, httpPort: 1081, apiPort: 1082, probeHttpPort: 1081 },
    });
    return tunnel.active;
  };
  tunnel.close = async () => { calls.push('close'); tunnel.active = null; };
  tunnel.cleanupAfterDrop = async () => { calls.push('cleanup'); };

  const noopPoller = () => ({
    attached: null,
    attach(s) { this.attached = s; },
    detach() { this.attached = null; },
    takeTraffic: () => ({ uplink: 0, downlink: 0 }),
    refreshBaseline() {},
  });

  const emitted = [];
  const notices = [];
  const core = new VpnCore({
    machine: new ConnectionMachine(),
    tunnel,
    telemetry: noopPoller(),
    tunnelStatus: noopPoller(),
    killSwitch: {
      blocking: false,
      armed: false,
      onConnected: async () => { calls.push('ks:connected'); },
      onSessionEnded: async () => { calls.push('ks:ended'); },
      syncAtStartup: async () => {},
    },
    systemProxy: {
      reconciles: [],
      reconcile: async ({ reason }) => { calls.push(`proxy:${reason}`); return {}; },
      status: () => ({ desired: false, active: false }),
      stop: () => {},
      withdrawForShutdown: async () => {},
    },
    health: Object.assign(new EventEmitter(), {
      startActive() {}, startBackup() {}, stopBackup() {}, stop() {},
      activeHealth: () => ({}), backupSnapshot: () => [],
    }),
    failover: Object.assign(new EventEmitter(), {
      resetSession() {}, snapshot: () => ({}), noteSwitchResult: () => ({}),
    }),
    reconnectPolicy: new ReconnectPolicy({ baseDelayMs: 20 }),
    dispatcherHost: { active: false, stats: null, neededFor: () => false },

    store: makeStore({ profiles }),
    getSettings: () => ({ autoReconnect: true, failoverEnabled: false, backupMonitoring: false }),
    findProfile: (id) => profiles.find((p) => p.id === id),
    getRoutingPolicy: () => ({ mode: 'proxy', lanDirect: true, rules: [] }),
    findFreePort: async (p) => p,
    proxyPing: async () => 30,
    testLocalProxy: async () => ({ ok: true }),
    notify: (title, body) => notices.push({ title, body }),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...overrides,
  });

  return { core, tunnel, calls, emitted, notices, profiles };
}

test('connecting brings the session up and points everything at it', async () => {
  const { core, calls } = makeCore();
  await core.connect('a');

  assert.equal(core.state, 'connected');
  assert.equal(core.session.profileId, 'a');
  assert.equal(core.telemetry.attached, core.session);
  assert.equal(core.tunnelStatus.attached, core.session);
  assert.equal(core.store.get('activeProfileId'), 'a');
  // The proxy is applied only after the tunnel is actually up.
  assert.deepEqual(calls, ['open:a', 'proxy:user', 'ks:connected']);
});

test('connecting again replaces the live session, withdrawing the proxy first', async () => {
  const { core, calls } = makeCore();
  await core.connect('a');
  calls.length = 0;
  await core.connect('b');

  assert.equal(core.session.profileId, 'b');
  // Withdraw before the listener dies, close, cover the gap with the Kill
  // Switch, then open the replacement and put the proxy back.
  assert.deepEqual(calls, [
    'proxy:disconnect', 'close', 'ks:ended', 'open:b', 'proxy:user', 'ks:connected',
  ]);
});

test('the system proxy is withdrawn before the listener stops accepting', async () => {
  // The session object still exists all through the teardown -- the teardown
  // needs it -- so "is there a session?" is the wrong question to ask at that
  // moment, and asking it would leave Windows pointed at a dead port.
  const { core, tunnel } = makeCore();
  await core.connect('a');
  assert.equal(core.proxyTarget().connected, true);

  const seen = [];
  core.systemProxy.reconcile = async ({ reason }) => {
    seen.push({ reason, target: core.proxyTarget().connected, tunnelUp: !!tunnel.active });
    return {};
  };
  await core.disconnect();

  const withdraw = seen.find((s) => s.reason === 'disconnect');
  assert.ok(withdraw, 'the proxy is reconciled on the way down');
  assert.equal(withdraw.tunnelUp, true, 'while the listener is still accepting');
  assert.equal(withdraw.target, false, 'and it is told to point nowhere');
});

test('a failed connect leaves nothing attached and reports idle', async () => {
  const { core, tunnel } = makeCore();
  tunnel.failWith = 'handshake failed';

  await assert.rejects(() => core.connect('a'), /handshake failed/);
  assert.equal(core.state, 'disconnected');
  assert.equal(core.session, null);
  assert.equal(core.telemetry.attached, null);
});

test('disconnecting tears everything down in the safe order', async () => {
  const { core, calls } = makeCore();
  await core.connect('a');
  calls.length = 0;
  await core.disconnect();

  assert.equal(core.state, 'disconnected');
  assert.deepEqual(calls, ['proxy:disconnect', 'close', 'ks:ended']);
});

test('disconnecting when nothing is running does nothing', async () => {
  const { core, calls } = makeCore();
  await core.disconnect();
  assert.deepEqual(calls, []);
});

// ---- the sweep races ----

test('a disconnect during a selection sweep cancels it', async () => {
  const { core, calls } = makeCore();
  let selectorFinished = false;

  const attempt = core.connectVia(async ({ signal }) => {
    await sleep(30);
    if (signal.aborted) throw Activity.cancelled();
    selectorFinished = true;
    return 'a';
  });

  await sleep(5);
  assert.equal(core.state, 'connecting', 'the sweep is visible as connecting');
  await core.disconnect();

  await assert.rejects(attempt, (err) => Activity.isCancellation(err));
  assert.equal(selectorFinished, false);
  assert.equal(core.state, 'disconnected');
  // The old bug: the sweep went on to connect anyway, right after the user
  // asked to stop.
  assert.ok(!calls.includes('open:a'));
});

test('a cancel that lands mid-handshake takes the tunnel back down', async () => {
  // Bringing a tunnel up is the one step that cannot be interrupted partway,
  // so a cancel arriving during it is honoured on the far side: the session is
  // closed immediately rather than being announced and left for whatever runs
  // next to tidy away.
  const { core, tunnel, calls } = makeCore();
  tunnel.openDelayMs = 30;

  const attempt = core.connectVia(async () => 'a');
  await sleep(5);
  await core.disconnect();

  await assert.rejects(attempt, (err) => Activity.isCancellation(err));
  assert.equal(core.state, 'disconnected');
  assert.equal(core.session, null);
  assert.deepEqual(calls, ['open:a', 'close'], 'opened, then immediately closed');
  assert.equal(core.store.get('activeProfileId'), null, 'and never recorded as the active server');
});

test('a failed sweep over a live tunnel goes back to connected, not disconnected', async () => {
  const { core } = makeCore();
  await core.connect('a');
  const live = core.session;

  await assert.rejects(
    () => core.connectVia(async () => { throw new Error('nothing answered'); }),
    /nothing answered/
  );

  // The old inline version reported "disconnected" while the tunnel it never
  // touched was still carrying traffic.
  assert.equal(core.state, 'connected');
  assert.equal(core.session, live);
});

test('cancelPending stops a sweep without touching the tunnel', async () => {
  const { core } = makeCore();
  await core.connect('a');
  const live = core.session;

  const attempt = core.connectVia(async ({ signal }) => {
    await sleep(30);
    if (signal.aborted) throw Activity.cancelled();
    return 'b';
  });
  await sleep(5);
  core.cancelPending('user');

  await assert.rejects(attempt, (err) => Activity.isCancellation(err));
  assert.equal(core.state, 'connected');
  assert.equal(core.session, live, 'cancelling a sweep is not disconnecting');
});

// ---- drops and auto-reconnect ----

test('a drop reconnects to the same server after the backoff', async () => {
  const { core, tunnel, calls } = makeCore();
  await core.connect('a');
  calls.length = 0;

  tunnel.emit('dropped', tunnel.active);
  tunnel.active = null;
  await sleep(80);

  assert.deepEqual(calls.slice(0, 3), ['cleanup', 'proxy:drop', 'ks:ended']);
  assert.ok(calls.includes('open:a'));
  assert.equal(core.state, 'connected');
});

test('a disconnect during the reconnect countdown wins', async () => {
  // The headline bug: the countdown was a bare setTimeout, and nothing
  // re-checked the user's intent after it elapsed -- so a user who disconnected
  // while the app was "reconnecting in 4s" got reconnected anyway.
  const { core, tunnel, calls } = makeCore();
  await core.connect('a');
  calls.length = 0;

  tunnel.emit('dropped', tunnel.active);
  tunnel.active = null;
  await sleep(5);

  await core.disconnect();
  await sleep(60);

  assert.equal(core.state, 'disconnected');
  assert.ok(!calls.includes('open:a'), 'the countdown was called off');
});

test('an explicit connect during the countdown supersedes it', async () => {
  const { core, tunnel, calls } = makeCore();
  await core.connect('a');
  calls.length = 0;

  tunnel.emit('dropped', tunnel.active);
  tunnel.active = null;
  await sleep(5);
  await core.connect('b');
  await sleep(60);

  assert.equal(core.session.profileId, 'b');
  assert.equal(calls.filter((c) => c.startsWith('open:')).length, 1, 'no second connect behind it');
});

test('auto-reconnect off means one notification and no retry', async () => {
  const { core, tunnel, calls, notices } = makeCore({
    getSettings: () => ({ autoReconnect: false, failoverEnabled: false, backupMonitoring: false }),
  });
  await core.connect('a');
  calls.length = 0;
  notices.length = 0;

  tunnel.emit('dropped', tunnel.active);
  tunnel.active = null;
  await sleep(60);

  assert.ok(!calls.includes('open:a'));
  assert.equal(notices.length, 1);
  assert.equal(core.state, 'disconnected');
});

test('the reconnect target can be re-chosen, for pool servers', async () => {
  // A pool server that just died is the one server guaranteed not to work.
  const { core, tunnel, calls } = makeCore({
    selectOnReconnect: async () => 'b',
  });
  await core.connect('a');
  calls.length = 0;

  tunnel.emit('dropped', tunnel.active);
  tunnel.active = null;
  await sleep(80);

  assert.ok(calls.includes('open:b'));
  assert.ok(!calls.includes('open:a'));
});

test('repeated drops give up after the attempt budget', async () => {
  const { core, tunnel } = makeCore();
  await core.connect('a');
  // Every reconnect fails from here on.
  tunnel.failWith = 'server gone';

  for (let i = 0; i < 7; i++) {
    tunnel.emit('dropped', tunnel.active);
    tunnel.active = null;
    await sleep(30);
  }
  assert.equal(core.state, 'disconnected');
  assert.ok(core.reconnectPolicy.attempts <= core.reconnectPolicy.maxAttempts);
});

// ---- reporting ----

test('the snapshot is one consistent view, not assembled from separate places', async () => {
  const { core } = makeCore();
  await core.connect('a');
  const snap = core.snapshot();

  assert.equal(snap.connectionState, 'connected');
  assert.equal(snap.connectedAt, core.session.startedAt);
  assert.equal(snap.dispatcherActive, false);
  assert.equal(snap.killSwitchBlocking, false);
});

test('isConnected follows the session, not the reported state', async () => {
  const { core } = makeCore();
  await core.connect('a');

  const attempt = core.connectVia(async ({ signal }) => {
    await sleep(30);
    if (signal.aborted) throw Activity.cancelled();
    return 'b';
  });
  await sleep(5);

  // Mid-sweep the UI says "connecting", but traffic is still flowing.
  assert.equal(core.state, 'connecting');
  assert.equal(core.isConnected, true);
  core.cancelPending();
  await assert.rejects(attempt, (err) => Activity.isCancellation(err));
});

test('traffic is folded into the profile lifetime total exactly once', async () => {
  const { core, profiles } = makeCore();
  core.telemetry.takeTraffic = () => ({ uplink: 100, downlink: 200 });
  await core.connect('a');
  await core.disconnect();

  const stored = core.store.get('profiles').find((p) => p.id === 'a');
  assert.equal(stored.totalBytes, 300);
  assert.equal(profiles[0].lastUsedAt > 0, true);
});

test('startup recovery reconciles the leftovers of an unclean exit', async () => {
  let staleRoutes = 0;
  const { core } = makeCore({ reconcileStaleRoutes: async () => { staleRoutes++; return 2; } });
  let syncedKillSwitch = 0;
  core.killSwitch.syncAtStartup = async () => { syncedKillSwitch++; };

  await core.recoverFromUnclean();
  assert.equal(syncedKillSwitch, 1);
  assert.equal(staleRoutes, 1);
});

test('shutdown disconnects and withdraws even if the disconnect throws', async () => {
  const { core, tunnel } = makeCore();
  await core.connect('a');
  tunnel.close = async () => { throw new Error('teardown exploded'); };

  let withdrew = 0;
  let routesTornDown = 0;
  core.systemProxy.withdrawForShutdown = async () => { withdrew++; };
  core.teardownRoutes = async () => { routesTornDown++; };

  await core.shutdown();
  // Leaving Windows pointed at a port that is about to stop existing is the one
  // failure that takes the user's internet down with it.
  assert.equal(withdrew, 1);
  assert.equal(routesTornDown, 1);
});
