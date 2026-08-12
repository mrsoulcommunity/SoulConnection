'use strict';
// Which port gets dialled, for which purpose. Getting these backwards produces
// measurements that are confidently wrong rather than obviously broken, so they
// are worth pinning down.
const test = require('node:test');
const assert = require('node:assert');
const { dialHost, probeTarget, systemProxyTarget, localProxyTarget } = require('../electron/vpn/endpoints.cjs');

const plain = {
  ports: { socksPort: 10808, httpPort: 10809, apiPort: 10810, probeHttpPort: 10809 },
};
// With the dispatcher in front, xray moves off the public ports entirely.
const dispatched = {
  ports: { socksPort: 10808, httpPort: 10809, apiPort: 10810, probeHttpPort: 20809 },
};
const settings = {
  httpHost: '0.0.0.0', socksHost: '0.0.0.0',
  httpUsername: 'u', httpPassword: 'p',
  socksUsername: 's', socksPassword: 'q',
};

test('a wildcard bind is never used as a dial address', () => {
  for (const host of ['0.0.0.0', '::', '[::]', '*', '', '  ', undefined]) {
    assert.equal(dialHost(host), '127.0.0.1');
  }
  assert.equal(dialHost('192.168.1.5'), '192.168.1.5');
});

test('probes go to xray own inbound, with credentials', () => {
  const t = probeTarget(plain, settings);
  assert.equal(t.port, 10809);
  assert.equal(t.host, '127.0.0.1', 'the wildcard listen host is not dialable');
  // Without these, xray answers the probe locally with a 407 and the reading
  // is a ~1ms round trip to nowhere.
  assert.equal(t.username, 'u');
  assert.equal(t.password, 'p');
});

test('with the dispatcher up, the probe bypasses it', () => {
  const t = probeTarget(dispatched, settings);
  assert.equal(t.port, 20809, 'the private inbound, not the public port');
  assert.equal(t.host, '127.0.0.1');
});

test('the system proxy is pointed at the public port, dispatcher or not', () => {
  // The opposite choice from the probe, on purpose: this is the listener the
  // rest of the machine reaches, and it is where the user's rules should apply.
  assert.equal(systemProxyTarget(plain, settings).port, 10809);
  assert.equal(systemProxyTarget(dispatched, settings).port, 10809);
  assert.equal(systemProxyTarget(dispatched, settings).host, '127.0.0.1');
});

test('no session means nothing to point at', () => {
  assert.equal(probeTarget(null, settings), null);
  assert.equal(localProxyTarget(null, settings, 'http'), null);
  assert.deepEqual(systemProxyTarget(null, settings), { connected: false });
});

test('the local proxy test uses the listener the user asked about', () => {
  const socks = localProxyTarget(plain, settings, 'socks');
  assert.equal(socks.port, 10808);
  assert.equal(socks.username, 's');
  const http = localProxyTarget(plain, settings, 'http');
  assert.equal(http.port, 10809);
  assert.equal(http.username, 'u');
});

test('a custom listen host is honoured rather than silently probing loopback', () => {
  const custom = { httpHost: '192.168.1.10', httpUsername: '', httpPassword: '' };
  assert.equal(probeTarget(plain, custom).host, '192.168.1.10');
  assert.equal(systemProxyTarget(plain, custom).host, '192.168.1.10');
});
