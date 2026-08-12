'use strict';
// Live measurements of the session that is running: how fast the tunnel
// answers, and how much has gone through it.
//
// THE BUG THIS FIXES
// ------------------
// Both polls used to be (re)started from `sendState()`, which main.cjs called
// for anything that changed anything -- a system-proxy drift tick every six
// seconds, a routing rule edit, a Kill Switch toggle. Each of those calls tore
// the traffic poll down and built it back up, and rebuilding it reset the
// counter baseline to zero. The next tick then divided the session's entire
// byte count by one second and reported it as the current speed, so the graph
// spiked to something absurd every few seconds for reasons that had nothing to
// do with traffic.
//
// The pollers are now driven by the session, not by state broadcasts: attaching
// the session that is already attached does nothing at all, and only a genuinely
// new tunnel (a different `session.id`) restarts anything.
const { sameSession } = require('./session.cjs');
const { probeTarget } = require('./endpoints.cjs');

const LATENCY_POLL_MS = 15000;
const TRAFFIC_POLL_MS = 1000;

// Runs `tick` on an interval with exactly one call in flight at a time, and
// stays bound to the session it was started for -- a result that arrives after
// the tunnel changed is dropped rather than attributed to its successor.
class SessionPoller {
  constructor({ intervalMs, tick, immediate = true }) {
    this.intervalMs = intervalMs;
    this.tick = tick;
    this.immediate = immediate;
    this.timer = null;
    this.inFlight = false;
    this.session = null;
  }

  start(session) {
    this.stop();
    this.session = session;
    const run = async () => {
      if (this.inFlight || !sameSession(this.session, session)) return;
      this.inFlight = true;
      try {
        await this.tick(session, () => sameSession(this.session, session));
      } catch {
        // A measurement is never allowed to take the connection with it.
      } finally {
        this.inFlight = false;
      }
    };
    if (this.immediate) run();
    this.timer = setInterval(run, this.intervalMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.session = null;
  }
}

class Telemetry {
  /**
   * @param {object} deps
   * @param {function} deps.getSettings      () => settings
   * @param {function} deps.proxyPing        (target) => Promise<ms>
   * @param {function} deps.createStatsClient (apiPort) => StatsClient
   * @param {function} deps.getLifetimeBytes (profileId) => number
   * @param {function} deps.emit             (channel, payload) => void
   */
  constructor({ getSettings, proxyPing, createStatsClient, getLifetimeBytes, emit }) {
    this.getSettings = getSettings;
    this.proxyPing = proxyPing;
    this.createStatsClient = createStatsClient;
    this.getLifetimeBytes = getLifetimeBytes;
    this.emit = emit;

    this.session = null;
    this.statsClient = null;
    // Cumulative counters for the live session, kept so a disconnect can add
    // them to the profile's lifetime total before they are lost.
    this.traffic = { uplink: 0, downlink: 0 };
    this.lastSample = null;

    this.latency = new SessionPoller({
      intervalMs: LATENCY_POLL_MS,
      tick: (session, current) => this._pollLatency(session, current),
    });
    this.trafficPoller = new SessionPoller({
      intervalMs: TRAFFIC_POLL_MS,
      tick: (session, current) => this._pollTraffic(session, current),
    });
  }

  /**
   * Point every poller at `session`. Idempotent for the session already
   * attached -- this is the whole point of the class.
   */
  attach(session) {
    if (sameSession(this.session, session)) return;
    this.detach();
    this.session = session;
    if (!session) return;

    this.traffic = { uplink: 0, downlink: 0 };
    this.lastSample = { uplink: 0, downlink: 0, time: Date.now() };
    if (session.ports.apiPort) {
      try {
        this.statsClient = this.createStatsClient(session.ports.apiPort);
      } catch {
        // Stats are a nice-to-have; a failure here must not break the connection.
        this.statsClient = null;
      }
    }
    this.latency.start(session);
    if (this.statsClient) this.trafficPoller.start(session);
  }

  detach() {
    this.latency.stop();
    this.trafficPoller.stop();
    if (this.statsClient) {
      try { this.statsClient.close(); } catch { /* ignore */ }
      this.statsClient = null;
    }
    this.session = null;
    this.lastSample = null;
  }

  /**
   * Hand over what this session moved and reset the counter, so the caller can
   * fold it into the profile's lifetime total exactly once.
   */
  takeTraffic() {
    const total = this.traffic;
    this.traffic = { uplink: 0, downlink: 0 };
    return total;
  }

  async _pollLatency(session, current) {
    // Credentials matter here: with HTTP proxy auth configured, an
    // unauthenticated probe is rejected locally with a 407 and never leaves the
    // machine -- which would report a ~1ms "tunnel latency".
    const ms = await this.proxyPing(probeTarget(session, this.getSettings()));
    if (!current()) return;
    this.emit('latency-update', { ms });
  }

  async _pollTraffic(session, current) {
    if (!this.statsClient) return;
    const { uplink, downlink } = await this.statsClient.queryOutboundTraffic('proxy');
    if (!current()) return;

    const now = Date.now();
    const last = this.lastSample || { uplink: 0, downlink: 0, time: now };
    const elapsed = Math.max((now - last.time) / 1000, 0.001);
    const uplinkSpeed = Math.max(0, (uplink - last.uplink) / elapsed);
    const downlinkSpeed = Math.max(0, (downlink - last.downlink) / elapsed);
    this.lastSample = { uplink, downlink, time: now };
    this.traffic = { uplink, downlink };

    this.emit('traffic-update', {
      uplink,
      downlink,
      uplinkSpeed,
      downlinkSpeed,
      sessionTotal: uplink + downlink,
      lifetimeTotal: this.getLifetimeBytes(session.profileId) + uplink + downlink,
    });
  }
}

module.exports = { Telemetry, SessionPoller, LATENCY_POLL_MS, TRAFFIC_POLL_MS };
