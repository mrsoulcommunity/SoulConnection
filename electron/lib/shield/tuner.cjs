'use strict';
// ---------------------------------------------------------------------------
// Adaptive Shield: the measurement.
//
// The question this answers is not "which anti-DPI trick is best" -- there is
// no such thing. It is "which one works on THIS connection, right now". The
// answer is a property of the user's ISP and whatever ruleset their censor
// deployed this week, it changes without warning, and it is not something a
// person can be expected to guess at from a dropdown.
//
// So we measure it, the same way the Server Finder already measures servers:
// stand up a real tunnel under each candidate treatment and push real requests
// through it. A treatment that cannot complete a handshake scores zero, which
// is exactly the signal we are looking for -- on a censored network the plain
// profile is the one that fails, and the winner is whatever still gets through.
//
// Two things keep this honest:
//
//   * Plain first, and plain wins ties. Fragmentation costs round trips and
//     noise costs bandwidth, so a treatment has to *earn* its place by a clear
//     margin. If the network is not interfering, the shield stays off.
//   * The probe is a real request over the tunnel, not a TCP handshake to the
//     server. A censor that lets the TCP connection open and then kills the
//     TLS session -- the common case now -- is invisible to anything cheaper.
//
// The whole run is bounded and cancellable: it stands up one xray process at a
// time and tears it down before the next, so a tune costs one process, never N.
// ---------------------------------------------------------------------------

const { EventEmitter } = require('events');
const { startTestTunnel, probeViaProxy } = require('../serverTest.cjs');
const { qualityScore } = require('../health/score.cjs');
const { PROFILES, DEFAULT_KEY, getProfile, appliesTo } = require('./profiles.cjs');

// Probes per candidate. Enough that one unlucky timeout does not condemn a
// working treatment, few enough that a six-profile sweep stays under a minute.
const PROBES = 5;
const PROBE_TIMEOUT_MS = 6000;
const PROBE_GAP_MS = 120;

// One throwaway probe before the counted ones, per candidate.
//
// Without it the comparison is rigged. Every candidate gets a fresh xray
// process, and its first request through that process pays for things the
// shield has nothing to do with: a cold DNS resolution, the first TCP session
// to the probe host, xray's own lazy setup. Measured on a loopback server that
// cost 900ms on the first candidate against 370ms on later ones -- a gap far
// larger than any real difference between treatments, and it always lands on
// whichever candidate runs first. Since plain always runs first, the bias
// pointed exactly the wrong way: it would have talked a perfectly healthy
// network into fragmenting its traffic for nothing.
const WARMUP_PROBES = 1;

// When plain loses no more than this share of its probes, the network is not
// interfering and the sweep stops there.
//
// The test is loss, deliberately not the blended quality score. Interference
// shows up as handshakes that never complete -- a blocked server loses 100% --
// while latency mostly measures how far away the server is. Scoring the two
// together conflates them: a perfectly clean tunnel to Europe sits around 400ms
// and scores 66, so a score-based cutoff of 70 would have declared a healthy
// connection suspect and fragmented it, every time, for a distance no amount of
// fragmentation can shorten. One flaky probe out of five is tolerated; anything
// worse is worth a full sweep.
const CLEAN_MAX_LOSS = 20;

// How much better a treatment has to score before it displaces plain. Below
// this the difference is measurement noise, and paying fragmentation's cost
// for noise is a bad trade.
const MARGIN = 12;

class ShieldTuner extends EventEmitter {
  constructor({ xrayBin, xrayAssetDir, workRoot }) {
    super();
    this.xrayBin = xrayBin;
    this.xrayAssetDir = xrayAssetDir;
    this.workRoot = workRoot;
    this._abort = null;
  }

  get running() {
    return !!this._abort;
  }

  cancel() {
    if (this._abort) this._abort.abort();
  }

  // Stands the server up under one treatment and reports what got through.
  async _measure(profile, key, signal) {
    let tunnel = null;
    const started = Date.now();
    try {
      tunnel = await startTestTunnel(profile, {
        xrayBin: this.xrayBin,
        xrayAssetDir: this.xrayAssetDir,
        workRoot: this.workRoot,
        signal,
        shield: key,
      });
    } catch (err) {
      // xray refusing to boot under a treatment is a legitimate result: that
      // treatment is simply not usable with this server.
      return { key, ok: false, score: null, latency: null, loss: 100, samples: [], error: err.message };
    }

    try {
      // Warmup first, and thrown away -- see WARMUP_PROBES.
      for (let i = 0; i < WARMUP_PROBES; i += 1) {
        if (signal.aborted) break;
        await probeViaProxy(tunnel.httpPort, PROBE_TIMEOUT_MS, signal);
      }

      const samples = [];
      for (let i = 0; i < PROBES; i += 1) {
        if (signal.aborted) break;
        samples.push(await probeViaProxy(tunnel.httpPort, PROBE_TIMEOUT_MS, signal));
        this.emit('probe', { key, done: samples.length, total: PROBES });
        if (i < PROBES - 1) await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
      }

      const good = samples.filter((v) => v > 0);
      const loss = samples.length ? Math.round(((samples.length - good.length) / samples.length) * 100) : 100;
      // Median, not mean: a single stalled request on an otherwise healthy
      // treatment would drag an average far enough to change the winner.
      const latency = median(good);
      // Same 0–100 scale the rest of the app reasons about, so a shield score
      // is directly comparable to a server's quality score.
      const score = good.length ? qualityScore({ latency, loss }) : 0;

      return {
        key, ok: good.length > 0, score, latency, loss, samples,
        bootMs: tunnel.bootMs, tookMs: Date.now() - started, error: null,
      };
    } finally {
      try { await tunnel.close(); } catch { /* the process is going away regardless */ }
    }
  }

  // Runs the sweep and returns { best, results }. `best` is the key to use.
  async tune(profile, { signal: outerSignal } = {}) {
    if (!appliesTo(profile)) {
      return { best: DEFAULT_KEY, results: [], skipped: 'not-applicable' };
    }

    const controller = new AbortController();
    this._abort = controller;
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;

    const results = [];
    try {
      const candidates = PROFILES.map((p) => p.key);
      for (let i = 0; i < candidates.length; i += 1) {
        if (signal.aborted) break;
        const key = candidates[i];
        this.emit('candidate', { key, index: i, total: candidates.length, label: getProfile(key).label });
        const r = await this._measure(profile, key, signal);
        results.push(r);
        this.emit('result', r);

        // Plain is measured first precisely so this shortcut exists: a healthy
        // unshielded connection means there is nothing to work around.
        if (key === DEFAULT_KEY && r.ok && r.loss <= CLEAN_MAX_LOSS) {
          this.emit('done', { best: DEFAULT_KEY, results, reason: 'clean-network' });
          return { best: DEFAULT_KEY, results, reason: 'clean-network' };
        }
      }

      const best = pickWinner(results);
      const reason = signal.aborted ? 'cancelled' : 'measured';
      this.emit('done', { best, results, reason });
      return { best, results, reason };
    } finally {
      this._abort = null;
    }
  }
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// Plain holds the field unless something clears it by a real margin. When
// plain is dead (a blocked network -- the case this feature exists for) the
// highest score wins outright.
function pickWinner(results) {
  const scored = results.filter((r) => r.ok && r.score != null);
  if (!scored.length) return DEFAULT_KEY;

  const plain = scored.find((r) => r.key === DEFAULT_KEY);
  const bestOther = scored
    .filter((r) => r.key !== DEFAULT_KEY)
    .sort((a, b) => b.score - a.score)[0];

  if (!bestOther) return DEFAULT_KEY;
  if (!plain) return bestOther.key;
  return bestOther.score >= plain.score + MARGIN ? bestOther.key : DEFAULT_KEY;
}

module.exports = { ShieldTuner, pickWinner, PROBES, CLEAN_MAX_LOSS, MARGIN };
