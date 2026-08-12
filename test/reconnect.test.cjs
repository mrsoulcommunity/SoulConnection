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

test('live config is read per decision, so a settings change applies to the next drop', () => {
  let budget = 2;
  const policy = new ReconnectPolicy({ getConfig: () => ({ maxAttempts: budget, baseDelayMs: 1000 }) });
  assert.equal(policy.next().delayMs, 1000);
  assert.equal(policy.next().delayMs, 2000);
  assert.equal(policy.next(), null, 'budget of two is spent');

  budget = 4; // the user just raised it in Settings
  assert.deepEqual(policy.next(), { attempt: 3, of: 4, delayMs: 3000 });
});

test('out-of-range user input is bounded, not obeyed', () => {
  const policy = new ReconnectPolicy({ getConfig: () => ({ maxAttempts: 9999, baseDelayMs: 0 }) });
  const cfg = policy.config();
  // "Retry forever, instantly" is not an option a settings file gets to pick.
  assert.equal(cfg.maxAttempts, 20);
  assert.equal(cfg.baseDelayMs, 500);
});

test('a policy with no live config keeps its constructed values exactly', () => {
  const policy = new ReconnectPolicy({ maxAttempts: 2, baseDelayMs: 20 });
  assert.deepEqual(policy.config(), { maxAttempts: 2, baseDelayMs: 20 });
});
