'use strict';
// ---------------------------------------------------------------------------
// Adaptive Shield: the part that remembers.
//
// A tuning result is only true for one pair of things -- this server, and this
// network. Carry it across either and it becomes a guess dressed up as a
// measurement: the fragmentation that rescued a connection on a censored
// mobile carrier is pure overhead on the office wifi, and the treatment that
// works for one server's provider says nothing about another's.
//
// So every choice is stored against a fingerprint of the network it was
// measured on, and silently ignored when the fingerprint no longer matches.
// Moving between networks re-tunes; moving back finds the earlier answer still
// there. Nothing is ever thrown away for being old, only for being from
// somewhere else -- a censor's ruleset changes far more slowly than a laptop
// changes wifi.
// ---------------------------------------------------------------------------

const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ShieldTuner } = require('./tuner.cjs');
const { DEFAULT_KEY, isKnown, getProfile, appliesTo } = require('./profiles.cjs');

const STORE_KEY = 'shieldChoices';
const MODES = new Set(['auto', 'off', 'manual']);

// A cheap, stable stand-in for "which network am I on".
//
// The first non-internal IPv4 interface's subnet plus its MAC identifies the
// link well enough for this purpose: it changes when the user moves between
// wifi networks, docks, or switches to a phone hotspot, and stays put across
// reboots and DHCP lease renewals on the same link. It never leaves the
// machine -- it is hashed, and only ever compared against itself.
function networkFingerprint() {
  const parts = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces).sort()) {
    for (const addr of ifaces[name] || []) {
      if (addr.internal || addr.family !== 'IPv4') continue;
      const subnet = String(addr.address).split('.').slice(0, 3).join('.');
      parts.push(`${subnet}/${addr.mac || ''}`);
    }
  }
  if (!parts.length) return 'offline';
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

class ShieldManager extends EventEmitter {
  constructor({ store, xrayBin, xrayAssetDir, workRoot, getMode, log }) {
    super();
    this.store = store;
    this.getMode = getMode || (() => 'auto');
    this.log = log || (() => {});
    this.tuner = new ShieldTuner({ xrayBin, xrayAssetDir, workRoot });
    this._tuning = null;

    this.tuner.on('candidate', (c) => this._emit({ phase: 'candidate', ...c }));
    this.tuner.on('probe', (p) => this._emit({ phase: 'probe', ...p }));
    this.tuner.on('result', (r) => this._emit({ phase: 'result', result: r }));
  }

  mode() {
    const m = this.getMode();
    return MODES.has(m) ? m : 'auto';
  }

  _choices() {
    const raw = this.store.get(STORE_KEY, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  // The stored choice for a server, or null when there isn't one that applies
  // to the network we are currently on.
  choiceFor(profileId) {
    const entry = this._choices()[profileId];
    if (!entry || !isKnown(entry.key)) return null;
    if (entry.net !== networkFingerprint()) return null;
    return entry;
  }

  // The key connect() should use. Manual mode pins one treatment for every
  // server; off disables the feature outright; auto uses whatever was measured
  // and falls back to plain until a tune has happened.
  keyFor(profile) {
    if (!profile || !appliesTo(profile)) return DEFAULT_KEY;
    const mode = this.mode();
    if (mode === 'off') return DEFAULT_KEY;
    if (mode === 'manual') {
      const pinned = this.store.get('shieldManualKey', DEFAULT_KEY);
      return isKnown(pinned) ? pinned : DEFAULT_KEY;
    }
    const choice = this.choiceFor(profile.id);
    return choice ? choice.key : DEFAULT_KEY;
  }

  _emit(payload) {
    this.emit('progress', { running: !!this._tuning, profileId: this._tuningId || null, ...payload });
  }

  get running() {
    return !!this._tuning;
  }

  cancel() {
    this.tuner.cancel();
  }

  // Measures this server on this network and remembers the winner.
  async tune(profile) {
    if (this._tuning) return this._tuning;
    if (!profile) throw new Error('کانفیگ پیدا نشد');
    if (!appliesTo(profile)) {
      // Shadowsocks has no TLS handshake for any of this to act on.
      return { best: DEFAULT_KEY, results: [], reason: 'not-applicable' };
    }

    this._tuningId = profile.id;
    this._emit({ phase: 'start', total: 6 });

    this._tuning = (async () => {
      try {
        const { best, results, reason } = await this.tuner.tune(profile);
        if (reason !== 'cancelled') {
          const choices = this._choices();
          choices[profile.id] = {
            key: best,
            net: networkFingerprint(),
            at: Date.now(),
            reason,
            // Kept so the UI can show what was actually measured rather than
            // just asserting a winner.
            results: results.map((r) => ({ key: r.key, ok: r.ok, score: r.score, latency: r.latency, loss: r.loss })),
          };
          this.store.set(STORE_KEY, choices);
          this.log(`[shield] ${profile.name || profile.id}: ${best} (${reason})`);
        }
        this._emit({ phase: 'done', best, reason, results });
        return { best, results, reason };
      } finally {
        this._tuning = null;
        this._tuningId = null;
      }
    })();

    return this._tuning;
  }

  // Everything the renderer needs to draw the panel for one server.
  state(profile) {
    const key = this.keyFor(profile);
    const choice = profile ? this.choiceFor(profile.id) : null;
    return {
      mode: this.mode(),
      manualKey: this.store.get('shieldManualKey', DEFAULT_KEY),
      running: this.running,
      runningFor: this._tuningId || null,
      activeKey: key,
      activeLabel: (getProfile(key) || {}).label || '',
      applicable: appliesTo(profile),
      choice: choice ? { key: choice.key, at: choice.at, reason: choice.reason, results: choice.results || [] } : null,
      network: networkFingerprint(),
    };
  }

  // Drops every stored measurement, so the next connect re-tunes from scratch.
  clear() {
    this.store.set(STORE_KEY, {});
    return true;
  }
}

module.exports = { ShieldManager, networkFingerprint, MODES, STORE_KEY };
