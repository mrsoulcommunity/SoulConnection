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

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

class ReconnectPolicy {
  constructor({ maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.attempts = 0;
  }

  reset() {
    this.attempts = 0;
  }

  get exhausted() {
    return this.attempts >= this.maxAttempts;
  }

  /**
   * Claim the next attempt, or null when the budget is spent. Linear backoff:
   * 2s, 4s, 6s, 8s, 10s -- long enough for a transient network change to
   * settle, short enough that the user is not left staring at a dead tunnel.
   */
  next() {
    if (this.exhausted) return null;
    this.attempts++;
    return {
      attempt: this.attempts,
      of: this.maxAttempts,
      delayMs: this.baseDelayMs * this.attempts,
    };
  }
}

module.exports = { ReconnectPolicy, MAX_ATTEMPTS, BASE_DELAY_MS };
