'use strict';
// What the outside world sees us as, measured from the outside.
//
// The only honest way to answer "is my traffic actually going through the
// tunnel?" is to ask something on the internet what address it sees, through
// the tunnel. Everything else -- the process is running, the port is bound, the
// handshake succeeded -- is an assumption.
//
// `baselineIp` is this machine's own un-tunnelled address, sampled ONLY while
// disconnected. Once a tunnel (or worse, TUN mode) is up there is no such thing
// as a "direct" request from here, and a reading taken then would be the
// tunnel's own address masquerading as the baseline. It exists purely so the UI
// can state whether the tunnel changed anything, is held in memory only, and is
// never written to disk.
const { sameSession } = require('./session.cjs');
const { probeTarget } = require('./endpoints.cjs');

const POLL_MS = 20000;
const BASELINE_TTL_MS = 15 * 60 * 1000;
const IDLE = Object.freeze({
  phase: 'idle', ip: null, country: null, countryCode: null, city: null,
  isp: null, asn: null, source: null, checkedAt: null, message: null,
  matchesServer: false, family: null,
});

class TunnelStatusTracker {
  /**
   * @param {object} deps
   * @param {function} deps.lookupPublicIp  ({proxy, timeoutMs}) => Promise<info>
   * @param {function} deps.getSettings     () => settings
   * @param {function} deps.getServerAddress (profileId) => string|null
   * @param {function} deps.emit            (status) => void
   */
  constructor({ lookupPublicIp, getSettings, getServerAddress, emit, log = () => {} }) {
    this.lookupPublicIp = lookupPublicIp;
    this.getSettings = getSettings;
    this.getServerAddress = getServerAddress;
    this.emit = emit;
    this.log = log;

    this.status = { phase: 'idle' };
    this.session = null;
    this.timer = null;
    this.inFlight = false;
    this.baseline = { ip: null, at: 0, inFlight: false };
  }

  snapshot() {
    return { ...this.status, baselineIp: this.baseline.ip };
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit(this.status);
  }

  /**
   * Follow the live session. Attaching the session already attached is a no-op,
   * so the tracker is not restarted (and the tunnel not re-probed) every time
   * something unrelated to it changes.
   */
  attach(session) {
    if (sameSession(this.session, session)) return;
    this.session = session;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (!session) {
      this._set(IDLE);
      this.refreshBaseline();
      return;
    }
    this.probe();
    this.timer = setInterval(() => this.probe(), POLL_MS);
  }

  // Deliberately never called on the connect path: a lookup at that moment
  // would delay the connection to answer a question nobody asked yet.
  refreshBaseline() {
    if (this.baseline.inFlight) return;
    if (this.baseline.ip && Date.now() - this.baseline.at < BASELINE_TTL_MS) return;
    this.baseline.inFlight = true;
    this.lookupPublicIp({ timeoutMs: 7000 })
      .then((info) => { this.baseline = { ip: info.ip, at: Date.now(), inFlight: false }; })
      .catch(() => { this.baseline = { ...this.baseline, inFlight: false }; });
  }

  async probe() {
    const session = this.session;
    if (!session || this.inFlight) return this.snapshot();
    this.inFlight = true;
    this._set({ phase: this.status.ip ? 'refreshing' : 'probing', message: null });
    try {
      const info = await this.lookupPublicIp({
        proxy: probeTarget(session, this.getSettings()),
        timeoutMs: 9000,
      });
      // A result that lands after a reconnect belongs to a tunnel that no
      // longer exists; it must not be attributed to the one that replaced it.
      if (!sameSession(this.session, session)) return this.snapshot();
      const serverAddress = this.getServerAddress(session.profileId);
      this._set({
        phase: 'ok',
        ...info,
        checkedAt: Date.now(),
        message: null,
        baselineIp: this.baseline.ip,
        // The exit is allowed to be the server itself (a plain, non-fronted
        // server egresses from its own address) -- but the user asked to be
        // told, so say it rather than leave them guessing.
        matchesServer: !!serverAddress && serverAddress === info.ip,
      });
    } catch (err) {
      if (!sameSession(this.session, session)) return this.snapshot();
      this.log(`[tunnel-ip] ${err.message} ${err.detail || ''}`);
      this._set({ phase: 'error', message: err.message, checkedAt: Date.now() });
    } finally {
      this.inFlight = false;
    }
    return this.snapshot();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.session = null;
  }
}

module.exports = { TunnelStatusTracker, POLL_MS, BASELINE_TTL_MS };
