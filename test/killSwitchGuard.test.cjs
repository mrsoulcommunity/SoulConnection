'use strict';
// Kill Switch arming. The rule that matters: until a tunnel has actually come
// up, a disconnect is "never connected yet", and blocking the machine's traffic
// then looks exactly like the app breaking the user's internet on launch.
const test = require('node:test');
const assert = require('node:assert');
const { KillSwitchGuard } = require('../electron/vpn/killSwitchGuard.cjs');

function makeGuard({ enabled = true, enableFails = false, active = false } = {}) {
  const calls = [];
  const rules = {
    enable: async () => { calls.push('enable'); if (enableFails) throw new Error('not elevated'); },
    disable: async () => { calls.push('disable'); },
    isActive: async () => active,
  };
  const notices = [];
  const guard = new KillSwitchGuard({
    killSwitch: rules,
    xrayBin: 'C:/xray.exe',
    isEnabled: () => enabled,
    notify: (title, body) => notices.push({ title, body }),
  });
  return { guard, calls, notices, setEnabled: (v) => { enabled = v; } };
}

test('a disconnect before the first tunnel never blocks', async () => {
  const { guard, calls } = makeGuard();
  await guard.onSessionEnded();
  assert.equal(guard.blocking, false);
  assert.deepEqual(calls, []);
});

test('once armed, a deliberate disconnect blocks too', async () => {
  const { guard, calls } = makeGuard();
  await guard.onConnected();
  assert.ok(guard.armed);
  await guard.onSessionEnded();

  assert.ok(guard.blocking);
  // "No traffic outside the tunnel, for any reason" includes the user's own
  // disconnect, not just drops.
  assert.deepEqual(calls, ['enable']);
});

test('connecting lifts an existing block', async () => {
  const { guard, calls } = makeGuard();
  await guard.onConnected();
  await guard.onSessionEnded();
  calls.length = 0;

  await guard.onConnected();
  assert.equal(guard.blocking, false);
  assert.deepEqual(calls, ['disable']);
});

test('a block that could not be applied is never reported as protection', async () => {
  const { guard, notices } = makeGuard({ enableFails: true });
  await guard.onConnected();
  await guard.onSessionEnded();

  assert.equal(guard.blocking, false, 'claiming protection we do not have is the one thing this cannot do');
  assert.equal(notices.length, 1);
});

test('blocking is idempotent', async () => {
  const { guard, calls } = makeGuard();
  await guard.onConnected();
  await guard.onSessionEnded();
  await guard.onSessionEnded();
  assert.equal(calls.filter((c) => c === 'enable').length, 1);
});

test('turning the feature on while connected arms immediately', async () => {
  const { guard } = makeGuard({ enabled: false });
  assert.equal(guard.armed, false);
  await guard.onSettingChanged(true, { connected: true });
  assert.ok(guard.armed, 'a drop later in this same session still has to be caught');
});

test('turning it off is an escape hatch that lifts the block at once', async () => {
  const { guard, calls } = makeGuard();
  await guard.onConnected();
  await guard.onSessionEnded();
  assert.ok(guard.blocking);
  calls.length = 0;

  await guard.onSettingChanged(false, { connected: false });
  assert.equal(guard.blocking, false);
  assert.equal(guard.armed, false);
  assert.deepEqual(calls, ['disable']);
});

test('startup with the feature off clears a rule left by a crash', async () => {
  const { guard, calls } = makeGuard({ enabled: false, active: true });
  await guard.syncAtStartup();
  assert.deepEqual(calls, ['disable']);
  assert.equal(guard.blocking, false);
});

test('startup with the feature on leaves the previous run protection in place', async () => {
  const { guard, calls } = makeGuard({ enabled: true, active: true });
  await guard.syncAtStartup();
  assert.deepEqual(calls, [], 'a lingering block is still doing its job');
  assert.equal(guard.blocking, true);
});

test('a session ending while the feature is off does nothing', async () => {
  const { guard, calls, setEnabled } = makeGuard();
  await guard.onConnected();
  setEnabled(false);
  await guard.onSessionEnded();
  assert.deepEqual(calls, []);
});
