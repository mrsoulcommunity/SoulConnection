'use strict';
// The connection state machine, on its own. No Electron, no xray, no timers --
// which is the point of having pulled it out of main.cjs in the first place.
const test = require('node:test');
const assert = require('node:assert');
const { ConnectionMachine, Activity } = require('../electron/vpn/machine.cjs');

test('starts idle', () => {
  const m = new ConnectionMachine();
  assert.equal(m.state, 'disconnected');
  assert.equal(m.epoch, 0);
  assert.ok(m.isIdle);
  assert.ok(!m.isBusy);
});

test('walks the normal connect/disconnect cycle', () => {
  const m = new ConnectionMachine();
  const seen = [];
  m.on('change', (c) => seen.push(`${c.from}->${c.to}`));

  assert.ok(m.to('connecting'));
  assert.ok(m.to('connected'));
  assert.ok(m.to('disconnecting'));
  assert.ok(m.to('disconnected'));
  assert.deepEqual(seen, [
    'disconnected->connecting',
    'connecting->connected',
    'connected->disconnecting',
    'disconnecting->disconnected',
  ]);
});

test('refuses an illegal transition instead of applying it', () => {
  const m = new ConnectionMachine();
  const refused = [];
  m.on('refused', (r) => refused.push(r));

  // A crash handler landing after the user's disconnect already completed must
  // not rewind the machine into a state it has left.
  assert.equal(m.to('connected'), false);
  assert.equal(m.state, 'disconnected');
  assert.equal(refused.length, 1);
});

test('a repeated transition is a no-op, not an event', () => {
  const m = new ConnectionMachine();
  m.to('connecting');
  let events = 0;
  m.on('change', () => { events++; });
  assert.equal(m.to('connecting'), false);
  assert.equal(events, 0);
});

test('epoch counts attempts and endings, not every move', () => {
  const m = new ConnectionMachine();
  m.to('connecting');
  const attempt = m.epoch;
  // Succeeding does not start a new lineage: work begun during the handshake
  // is still about this same attempt.
  m.to('connected');
  assert.equal(m.epoch, attempt);
  assert.ok(m.isCurrentEpoch(attempt));

  m.to('disconnecting');
  assert.equal(m.epoch, attempt, 'tearing down is still the same lineage');
  m.to('disconnected');
  assert.ok(!m.isCurrentEpoch(attempt), 'coming to rest ends it');
});

test('connected -> connecting is legal and keeps the tunnel modelled honestly', () => {
  // "Connect to the best server" while already connected: the sweep runs with
  // the old tunnel still carrying traffic.
  const m = new ConnectionMachine();
  m.to('connecting');
  m.to('connected');
  assert.ok(m.to('connecting'), 'a new attempt may begin over a live tunnel');
  assert.ok(m.to('connected'), 'and may fall back to the tunnel that never died');
});

test('starting an activity cancels the one it supersedes', () => {
  const m = new ConnectionMachine();
  const first = m.beginActivity('reconnect');
  assert.ok(first.live);

  const second = m.beginActivity('connect');
  assert.ok(first.cancelled, 'the pending reconnect is called off');
  assert.ok(!first.live);
  assert.ok(second.live);
  assert.equal(m.activity, second);
});

test('cancelActivity aborts the signal a sleeping operation is waiting on', async () => {
  const m = new ConnectionMachine();
  const activity = m.beginActivity('reconnect');

  let aborted = false;
  activity.signal.addEventListener('abort', () => { aborted = true; });
  m.cancelActivity('user-disconnected');

  assert.ok(aborted);
  assert.ok(activity.cancelled);
  assert.equal(m.activity, null);
  assert.throws(() => activity.throwIfCancelled(), (err) => Activity.isCancellation(err));
});

test('ending an activity releases the slot without cancelling anything else', () => {
  const m = new ConnectionMachine();
  const a = m.beginActivity('connect');
  a.end();
  assert.equal(m.activity, null);
  assert.ok(!a.cancelled, 'finishing is not cancelling');
  // A later cancel must not resurrect the finished activity.
  assert.equal(m.cancelActivity(), false);
});

test('exclusive() serializes work and survives a rejection', async () => {
  const m = new ConnectionMachine();
  const order = [];
  const slow = m.exclusive(async () => {
    order.push('a:start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('a:end');
    throw new Error('boom');
  });
  const next = m.exclusive(async () => { order.push('b'); return 'b-done'; });

  await assert.rejects(slow, /boom/);
  assert.equal(await next, 'b-done');
  assert.deepEqual(order, ['a:start', 'a:end', 'b'], 'b never overlapped a');
});

test('a queued command can tell that it was cancelled while waiting', async () => {
  // The shape the real connect path relies on: queue behind something slow,
  // get cancelled meanwhile, and refuse to run rather than connecting after
  // the user asked to stop.
  const m = new ConnectionMachine();
  const activity = m.beginActivity('connect');
  let ran = false;

  const blocker = m.exclusive(() => new Promise((r) => setTimeout(r, 20)));
  const queued = m.exclusive(async () => {
    activity.throwIfCancelled();
    ran = true;
  });

  m.cancelActivity('disconnect');
  await blocker;
  await assert.rejects(queued, (err) => Activity.isCancellation(err));
  assert.equal(ran, false);
});
