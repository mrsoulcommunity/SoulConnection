'use strict';
// Kill Switch: "no traffic outside the tunnel, for any reason".
//
// TWO FACTS, NOT ONE
// ------------------
//   blocking  the outbound-block firewall rules are in place right now. Only
//             ever set after the rules actually landed -- claiming protection
//             we do not have is the one failure this feature cannot afford.
//   armed     we have had at least one successful tunnel this run (or the user
//             turned the feature on while already connected). Until armed, a
//             disconnect is not "the VPN dropping", it is "never connected
//             yet", and blocking the machine's traffic then would look exactly
//             like the app breaking the user's internet on launch.
//
// The rules themselves live in lib/killSwitch.cjs; this owns when they go on
// and off, which is the part that has to agree with the connection lifecycle.
class KillSwitchGuard {
  /**
   * @param {object} deps
   * @param {object} deps.killSwitch   lib/killSwitch.cjs
   * @param {string} deps.xrayBin      allowed through the block
   * @param {function} deps.isEnabled  () => boolean (the user's setting)
   * @param {function} deps.notify     (title, body) => void
   * @param {function} deps.onChange   () => void, whenever `blocking` moves
   */
  constructor({ killSwitch, xrayBin, isEnabled, notify = () => {}, onChange = () => {} }) {
    this.killSwitch = killSwitch;
    this.xrayBin = xrayBin;
    this.isEnabled = isEnabled;
    this.notify = notify;
    this.onChange = onChange;

    this.blocking = false;
    this.armed = false;
  }

  /**
   * Reconcile with whatever is actually on the firewall right now. If the
   * feature is off, clean up any rule left behind by a previous crash -- the
   * stored preference is the source of truth for whether blocking *should* be
   * happening. If it is on, leave a lingering block exactly as-is: that is the
   * previous session's protection still doing its job until the user
   * reconnects or disables it.
   */
  async syncAtStartup() {
    if (!this.isEnabled()) {
      await this.killSwitch.disable().catch(() => {});
      this.blocking = false;
      return;
    }
    try {
      this.blocking = await this.killSwitch.isActive();
    } catch {
      this.blocking = false;
    }
    this.onChange();
  }

  // Idempotent and best-effort: if it fails (most likely: not actually
  // elevated) we surface a notification but must not claim protection we do
  // not have, so `blocking` stays false.
  async block() {
    if (this.blocking) return;
    try {
      await this.killSwitch.enable(this.xrayBin);
      this.blocking = true;
    } catch (err) {
      this.notify('خطا در Kill Switch', 'مسدودسازی ترافیک ناموفق بود: ' + (err.message || ''));
    }
    this.onChange();
  }

  // Always safe to call. This is also the emergency escape hatch invoked the
  // moment the user flips the setting off.
  async clear() {
    if (!this.blocking) return;
    try { await this.killSwitch.disable(); } catch { /* best effort */ }
    this.blocking = false;
    this.onChange();
  }

  // A tunnel came up: from here on a disconnect means something.
  async onConnected() {
    if (!this.isEnabled()) return;
    this.armed = true;
    await this.clear();
  }

  // A session ended -- deliberately, or by dropping. Both count: the feature
  // means no traffic outside the tunnel, including during the user's own
  // disconnect and during the seconds an auto-reconnect is retrying.
  async onSessionEnded() {
    if (!this.armed || !this.isEnabled()) return;
    await this.block();
  }

  // The setting itself changed. Turning it on while already connected arms
  // immediately, so a drop later in *this* session is still caught instead of
  // waiting for the next successful connect.
  async onSettingChanged(enabled, { connected }) {
    if (enabled) {
      if (connected) this.armed = true;
      return;
    }
    await this.clear();
    this.armed = false;
  }
}

module.exports = { KillSwitchGuard };
