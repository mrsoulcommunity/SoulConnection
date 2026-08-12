'use strict';
// The xray process handle, against a real spawned process.
//
// The regression here was found by running the app: killing the tunnel from
// outside left `isRunning` stuck on true forever, so auto-reconnect -- and
// every later connect -- failed with "Xray is already running" until the app
// was restarted. That is the exact moment recovery matters most.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { XrayProcess } = require('../electron/lib/xrayProcess.cjs');

// A stand-in that prints the line start() waits for and then stays alive.
function makeFakeBinary(dir) {
  const bin = path.join(dir, 'fake-xray.sh');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Xray started"\nwhile :; do sleep 0.2; done\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-test-'));
  return { dir, bin: makeFakeBinary(dir), work: path.join(dir, 'run') };
}

const skip = process.platform === 'win32' ? { skip: 'POSIX-only fake binary' } : {};

test('a process killed by a signal is not still "running"', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [] });
  assert.equal(xray.isRunning, true);

  const exited = once(xray, 'exit');
  // SIGKILL from outside, the way a crash, an OOM reap or Task Manager ends it:
  // exitCode stays null (the exit was a signal) and `killed` stays false
  // (that flag only means *we* called .kill()). Inferring liveness from those
  // two reported "still running" for a process that no longer existed.
  process.kill(xray.proc.pid, 'SIGKILL');
  await exited;

  assert.equal(xray.isRunning, false);
});

test('the tunnel can be restarted after being killed from outside', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [] });
  const exited = once(xray, 'exit');
  process.kill(xray.proc.pid, 'SIGKILL');
  await exited;

  // This is what auto-reconnect does, and what used to reject outright.
  await xray.start({ inbounds: [] });
  assert.equal(xray.isRunning, true);
  await xray.stop();
});

test('a listener may start a replacement from inside the exit handler', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [] });

  // Auto-reconnect reacts to `exit`, so the handle must already read as free
  // by the time the event fires -- not one tick later.
  const seen = [];
  xray.once('exit', () => seen.push(xray.isRunning));
  const exited = once(xray, 'exit');
  process.kill(xray.proc.pid, 'SIGKILL');
  await exited;

  assert.deepEqual(seen, [false]);
});

test('stopping a process that is already gone resolves at once', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [] });
  const exited = once(xray, 'exit');
  process.kill(xray.proc.pid, 'SIGKILL');
  await exited;

  // Previously this waited out the full three-second SIGKILL timer for an exit
  // event that had already been emitted, stalling every teardown after a crash.
  const startedAt = Date.now();
  await xray.stop();
  assert.ok(Date.now() - startedAt < 500, 'stop() returned promptly');
});

test('a deliberate stop ends the process and frees the handle', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [] });
  await xray.stop();
  assert.equal(xray.isRunning, false);
  await xray.start({ inbounds: [] });
  assert.equal(xray.isRunning, true);
  await xray.stop();
});

test('the config is written where xray is told to read it', skip, async (t) => {
  const { dir, bin, work } = workspace();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xray = new XrayProcess(bin, work);
  await xray.start({ inbounds: [{ port: 10808 }] });
  t.after(() => xray.stop());

  const written = JSON.parse(fs.readFileSync(xray.configPath, 'utf8'));
  assert.deepEqual(written.inbounds, [{ port: 10808 }]);
});
