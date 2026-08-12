'use strict';
// How hard, and how often, to try again after the tunnel drops on its own.
//
// Split out from the crash handler because the handler was doing four
// unrelated jobs at once -- deciding whether the exit was a crash, engaging the
// Kill Switch, choosing between "retry this server" and "re-run pool
// selection", and counting attempts with a bare module-level integer. Only the
// counting is policy, and policy is the part worth being able to test.
//
// The counter is reset by a *successful connection*, not by an attempt, so five
// failures in a row give up while a flaky link that recovers each time never
// exhausts its budget.

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

class ReconnectPolicy {
  /**
   * `getConfig` is read on every decision rather than captured once, so
   * changing the budget in Settings applies to the drop that happens next --
   * not to the one after the app is restarted.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxAttempts]
   * @param {number} [opts.baseDelayMs]
   * @param {function} [opts.getConfig] () => { maxAttempts, baseDelayMs }
   */
  constructor({ maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS, getConfig = null } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.getConfig = getConfig;
    this.attempts = 0;
  }

  // Live config is user input and is bounded; the constructor's own values are
  // code-supplied and taken as given. This governs how long the app keeps
  // trying while the user has no internet, so an out-of-range number reaching
  // it -- from a hand-edited settings file, or a control that grows a new
  // option later -- must not turn into "retry forever, instantly".
  config() {
    const live = this.getConfig ? this.getConfig() || {} : {};
    return {
      maxAttempts: Number.isFinite(live.maxAttempts)
        ? clamp(Math.round(live.maxAttempts), 1, 20) : this.maxAttempts,
      baseDelayMs: Number.isFinite(live.baseDelayMs)
        ? clamp(Math.round(live.baseDelayMs), 500, 30000) : this.baseDelayMs,
    };
  }

  reset() {
    this.attempts = 0;
  }

  get exhausted() {
    return this.attempts >= this.config().maxAttempts;
  }

  /**
   * Claim the next attempt, or null when the budget is spent. Linear backoff:
   * with the default 2s step that is 2s, 4s, 6s, 8s, 10s -- long enough for a
   * transient network change to settle, short enough that the user is not left
   * staring at a dead tunnel.
   */
  next() {
    const { maxAttempts, baseDelayMs } = this.config();
    if (this.attempts >= maxAttempts) return null;
    this.attempts++;
    return {
      attempt: this.attempts,
      of: maxAttempts,
      delayMs: baseDelayMs * this.attempts,
    };
  }
}

module.exports = { ReconnectPolicy, MAX_ATTEMPTS, BASE_DELAY_MS };
