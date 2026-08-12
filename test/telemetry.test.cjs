'use strict';
// Session-scoped measurement. The regression these cover: both pollers used to
// be restarted by every state broadcast, and restarting the traffic poll reset
// its counter baseline -- so the reported speed spiked to "everything this
// session has ever moved, per second" every few seconds.
const test = require('node:test');
const assert = require('node:assert');
const { Telemetry } = require('../electron/vpn/telemetry.cjs');
const { createSession } = require('../electron/vpn/session.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTelemetry({ counters = [], latency = 42 } = {}) {
  const emitted = [];
  const created = [];
  let closed = 0;
  let cursor = 0;

  const telemetry = new Telemetry({
    getSettings: () => ({ httpHost: '127.0.0.1', httpUsername: '', httpPassword: '' }),
    proxyPing: async () => latency,
    createStatsClient: (apiPort) => {
      created.push(apiPort);
      return {
        queryOutboundTraffic: async () => counters[Math.min(cursor++, counters.length - 1)],
        close: () => { closed++; },
      };
    },
    getLifetimeBytes: () => 5000,
    emit: (channel, payload) => emitted.push({ channel, payload }),
  });

  return { telemetry, emitted, created, stats: { get closed() { return closed; } } };
}

function session(id = 1) {
  return createSession({
    profileId: `p${id}`,
    mode: 'proxy',
    ports: { socksPort: 10808, httpPort: 10809, apiPort: 10810, probeHttpPort: 10809 },
  });
}

test('re-attaching the same session rebuilds nothing', async (t) => {
  const { telemetry, created } = makeTelemetry({ counters: [{ uplink: 0, downlink: 0 }] });
  t.after(() => telemetry.detach());
  const s = session();

  telemetry.attach(s);
  telemetry.attach(s);
  telemetry.attach(s);

  // One stats client, one baseline, no spike -- however many times something
  // unrelated asks the app to re-broadcast its state.
  assert.equal(created.length, 1);
});

test('a genuinely new session gets a fresh client', async (t) => {
  const { telemetry, created } = makeTelemetry({ counters: [{ uplink: 0, downlink: 0 }] });
  t.after(() => telemetry.detach());

  telemetry.attach(session(1));
  telemetry.attach(session(2));
  assert.equal(created.length, 2);
  assert.equal(telemetry.session.profileId, 'p2');
});

test('speed is the delta since the last sample, not the session total', async (t) => {
  const { telemetry, emitted } = makeTelemetry({
    counters: [
      { uplink: 1000, downlink: 2000 },
      { uplink: 1100, downlink: 2100 },
    ],
  });
  t.after(() => telemetry.detach());
  const s = session();
  telemetry.attach(s);
  await sleep(30);

  // Exactly what used to reset the baseline: state re-broadcast mid-session.
  telemetry.attach(s);
  await telemetry._pollTraffic(s, () => true);

  const traffic = emitted.filter((e) => e.channel === 'traffic-update');
  assert.ok(traffic.length >= 2);
  const last = traffic[traffic.length - 1].payload;
  assert.equal(last.uplink, 1100);
  assert.equal(last.sessionTotal, 3200);
  assert.equal(last.lifetimeTotal, 5000 + 3200);
  // 200 bytes over the gap, not 3200 over one tick.
  assert.ok(last.uplinkSpeed < 1000 / 0.03, `speed spiked: ${last.uplinkSpeed}`);
});

test('a result that lands after the session changed is dropped', async (t) => {
  const { telemetry, emitted } = makeTelemetry({ counters: [{ uplink: 10, downlink: 10 }] });
  t.after(() => telemetry.detach());
  const s = session();
  telemetry.attach(s);
  await sleep(10); // let the polls attach() kicks off settle first
  emitted.length = 0;

  await telemetry._pollTraffic(s, () => false); // "this is no longer the live session"
  await telemetry._pollLatency(s, () => false);
  assert.equal(emitted.length, 0);
});

test('takeTraffic hands over the total exactly once', async (t) => {
  const { telemetry } = makeTelemetry({ counters: [{ uplink: 700, downlink: 300 }] });
  t.after(() => telemetry.detach());
  const s = session();
  telemetry.attach(s);
  await telemetry._pollTraffic(s, () => true);

  assert.deepEqual(telemetry.takeTraffic(), { uplink: 700, downlink: 300 });
  assert.deepEqual(telemetry.takeTraffic(), { uplink: 0, downlink: 0 }, 'not counted twice');
});

test('latency is reported through the probe endpoint', async (t) => {
  const { telemetry, emitted } = makeTelemetry({ counters: [{ uplink: 0, downlink: 0 }], latency: 88 });
  t.after(() => telemetry.detach());
  const s = session();
  telemetry.attach(s);
  await telemetry._pollLatency(s, () => true);

  const latency = emitted.filter((e) => e.channel === 'latency-update');
  assert.equal(latency[latency.length - 1].payload.ms, 88);
});

test('detaching closes the stats client and stops the timers', () => {
  const { telemetry, stats } = makeTelemetry({ counters: [{ uplink: 0, downlink: 0 }] });
  telemetry.attach(session());
  telemetry.detach();

  assert.equal(stats.closed, 1);
  assert.equal(telemetry.session, null);
  assert.equal(telemetry.latency.timer, null);
  assert.equal(telemetry.trafficPoller.timer, null);
});

test('a session with no stats port still measures latency', (t) => {
  const { telemetry, created } = makeTelemetry();
  t.after(() => telemetry.detach());
  telemetry.attach(createSession({
    profileId: 'p9',
    mode: 'proxy',
    ports: { socksPort: 1, httpPort: 2, apiPort: 0, probeHttpPort: 2 },
  }));
  assert.equal(created.length, 0, 'stats are a nice-to-have, not a requirement');
  assert.ok(telemetry.latency.timer);
});
