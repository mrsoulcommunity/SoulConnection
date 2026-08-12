'use strict';
// The connection state machine: the one place that decides what state the VPN
// is in, and the one place that can say whether a piece of work in flight is
// still relevant.
//
// WHAT IT REPLACES
// ----------------
// `connectionState` used to be a bare string on the module scope of main.cjs,
// assigned from eight different places -- connect(), disconnect(), the xray
// crash handler, the pool sweep, the "connect to best" sweep, and their error
// paths. Two of those wrote it from *outside* the serialization lock, which is
// how a disconnect issued during a server-selection sweep could be quietly
// overwritten by the connect that the sweep went on to perform.
//
// THREE IDEAS, AND THAT IS ALL
// ----------------------------
//   state      disconnected -> connecting -> connected -> disconnecting -> ...
//              Illegal transitions are refused rather than applied, so a crash
//              landing at the same moment as a user disconnect cannot rewind
//              the machine into a state the caller has already left behind.
//
//   epoch      bumped when a new attempt starts (entering `connecting`) and
//              when the machine comes to rest (entering `disconnected`).
//              `connecting -> connected` deliberately does NOT bump it: those
//              two states are the same attempt, so work started during the
//              handshake stays valid once it succeeds.
//
//   activity   the cancellable span of a long operation -- a selection sweep,
//              an auto-reconnect's backoff wait, a reconnect chain. At most one
//              exists at a time and starting another cancels the first, which
//              is what makes "the user pressed disconnect" reliably stop work
//              that has not reached the exclusive section yet. An epoch alone
//              cannot do this: a pending reconnect sits in `disconnected` with
//              nothing to bump.
//
// Nothing in here knows about xray, ports, Electron or Windows. It is a plain
// object with timers nowhere in sight, which is exactly why it can be tested.
const { EventEmitter } = require('events');

const STATES = ['disconnected', 'connecting', 'connected', 'disconnecting'];

// Every legal move. Anything absent is refused.
//   connecting -> disconnected   an attempt that failed
//   connected  -> disconnected   the tunnel dropped underneath us (crash)
//   connected  -> connecting     a new attempt began while the old tunnel is
//                                still carrying traffic. That is what a "connect
//                                to the best server" sweep does, and modelling
//                                it honestly is what lets a failed sweep put the
//                                machine back to `connected` instead of
//                                reporting "disconnected" over a live tunnel,
//                                which is what the old inline assignments did.
const TRANSITIONS = {
  disconnected: ['connecting'],
  connecting: ['connected', 'disconnecting', 'disconnected'],
  connected: ['connecting', 'disconnecting', 'disconnected'],
  disconnecting: ['disconnected'],
};

// Entering these means "start over", which is what an epoch counts.
const EPOCH_BUMPING = new Set(['connecting', 'disconnected']);

class Activity {
  constructor(machine, kind, reason) {
    this.machine = machine;
    this.kind = kind;
    this.reason = reason;
    this.epoch = machine.epoch;
    this.startedAt = Date.now();
    this.controller = new AbortController();
    this.ended = false;
  }

  get signal() {
    return this.controller.signal;
  }

  get cancelled() {
    return this.controller.signal.aborted;
  }

  // Still the activity the machine is running, and not cancelled. Every await
  // in a long operation should be followed by a check of this.
  get live() {
    return !this.cancelled && this.machine.activity === this;
  }

  // Convenience for the common `if (!activity.live) throw` shape, so callers
  // don't each invent their own cancellation error.
  throwIfCancelled() {
    if (!this.live) throw Activity.cancelled();
  }

  static cancelled(message = 'لغو شد') {
    return Object.assign(new Error(message), { code: 'ABORTED' });
  }

  static isCancellation(err) {
    return !!err && (err.code === 'ABORTED' || err.name === 'AbortError');
  }

  cancel(reason = 'superseded') {
    if (this.cancelled) return;
    this.cancelReason = reason;
    this.controller.abort();
  }

  end() {
    this.ended = true;
    if (this.machine.activity === this) this.machine._clearActivity(this);
  }
}

class ConnectionMachine extends EventEmitter {
  constructor() {
    super();
    this.state = 'disconnected';
    this.epoch = 0;
    this.activity = null;
    // Serializes the critical sections that actually touch the OS, so two
    // connects (or a connect and a disconnect) can never interleave their
    // process spawns, route edits and registry writes.
    this._chain = Promise.resolve();
  }

  get isConnected() {
    return this.state === 'connected';
  }

  get isIdle() {
    return this.state === 'disconnected';
  }

  get isBusy() {
    return this.state === 'connecting' || this.state === 'disconnecting';
  }

  snapshot() {
    return { state: this.state, epoch: this.epoch };
  }

  can(next) {
    return (TRANSITIONS[this.state] || []).includes(next);
  }

  /**
   * Move to `next`. Returns false (changing nothing) if the move is illegal
   * from where we are -- callers racing each other are expected to check.
   *
   * The machine deliberately does NOT hold the live session: that belongs to
   * whatever owns the OS resources (vpn/tunnel.cjs), and keeping a second copy
   * here is how the two would eventually disagree.
   */
  to(next, { reason = 'unknown' } = {}) {
    if (!STATES.includes(next)) throw new Error(`Unknown connection state: ${next}`);
    if (next === this.state) return false;
    if (!this.can(next)) {
      this.emit('refused', { from: this.state, to: next, reason });
      return false;
    }

    const from = this.state;
    this.state = next;
    if (EPOCH_BUMPING.has(next)) this.epoch++;

    this.emit('change', { from, to: next, reason, epoch: this.epoch });
    return true;
  }

  // ---- activities ----

  /**
   * Claim the machine's single activity slot. Whatever was running before is
   * cancelled first: a user pressing "connect" while an auto-reconnect is
   * counting down means the countdown is over, not that both should happen.
   */
  beginActivity(kind, reason = kind) {
    this.cancelActivity(`superseded-by-${kind}`);
    const activity = new Activity(this, kind, reason);
    this.activity = activity;
    this.emit('activity', { kind, reason, active: true });
    return activity;
  }

  cancelActivity(reason = 'cancelled') {
    const activity = this.activity;
    if (!activity) return false;
    this.activity = null;
    activity.cancel(reason);
    this.emit('activity', { kind: activity.kind, reason, active: false });
    return true;
  }

  _clearActivity(activity) {
    if (this.activity !== activity) return;
    this.activity = null;
    this.emit('activity', { kind: activity.kind, reason: 'done', active: false });
  }

  // ---- exclusive section ----

  /**
   * Run `fn` with nothing else in the critical section. Queued, never
   * concurrent, and a rejection neither breaks the chain nor blocks the work
   * behind it.
   */
  exclusive(fn) {
    const result = this._chain.then(fn, fn);
    this._chain = result.then(() => {}, () => {});
    return result;
  }

  // True when `epoch` is still the machine's current one -- the cheap guard for
  // any result that arrives after an await.
  isCurrentEpoch(epoch) {
    return this.epoch === epoch;
  }
}

module.exports = { ConnectionMachine, Activity, STATES, TRANSITIONS };
