'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ReconnectPolicy } = require('../electron/vpn/reconnect.cjs');

test('backs off linearly and gives up after five tries', () => {
  const policy = new ReconnectPolicy();
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push(policy.next().delayMs);
  assert.deepEqual(delays, [2000, 4000, 6000, 8000, 10000]);
  assert.equal(policy.next(), null);
  assert.ok(policy.exhausted);
});

test('reports which attempt this is, for the notification', () => {
  const policy = new ReconnectPolicy();
  assert.deepEqual(policy.next(), { attempt: 1, of: 5, delayMs: 2000 });
  assert.deepEqual(policy.next(), { attempt: 2, of: 5, delayMs: 4000 });
});

test('a successful connection restores the full budget', () => {
  // A flaky link that recovers each time must never exhaust its attempts.
  const policy = new ReconnectPolicy();
  policy.next();
  policy.next();
  policy.reset();
  assert.equal(policy.attempts, 0);
  assert.equal(policy.next().attempt, 1);
});
