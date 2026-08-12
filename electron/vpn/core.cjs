'use strict';
// The VPN core: one object that owns everything about being connected.
//
// WHAT THIS IS FOR
// ----------------
// Connecting is not one action, it is eight of them that have to agree with
// each other: a process, a dispatcher, an adapter and its routes, the Windows
// proxy configuration, a firewall block, three measurement loops, and a
// failover engine watching the result. Those used to be wired together by
// ordering rules spread across main.cjs -- "call this before that or the user
// loses their internet" -- with each subsystem re-deriving whether it should be
// running by inspecting the same handful of globals.
//
// Here there is one lifecycle, and every subsystem hangs off it:
//
//     command  ->  machine  ->  tunnel  ->  session
//                                             |
//                    telemetry / tunnel status / health / failover
//                    system proxy / kill switch      all follow the session
//
// COORDINATION ONLY
// -----------------
// This class builds nothing. Every collaborator arrives through the
// constructor, which is what keeps the interesting behaviour -- the ordering,
// the cancellation, the rollback -- exercisable without a Windows machine, an
// xray binary or a network. The real ones are assembled in index.cjs, which is
// the only file that knows which implementations are the real implementations.
const { EventEmitter } = require('events');

const { Activity } = require('./machine.cjs');
const { buildRoutingPlan, planSignature } = require('./routingPlan.cjs');
const { allocatePorts } = require('./ports.cjs');
const { probeTarget, localProxyTarget, systemProxyTarget } = require('./endpoints.cjs');
const { sameSession } = require('./session.cjs');

// Who the failover engine is allowed to move to -- the caller decides which
// servers those are; this is only the ceiling on how many get probed.
const MAX_FAILOVER_CANDIDATES = 40;

// How long after launch the un-tunnelled baseline address is sampled. Long
// enough for an auto-connect-on-startup to have claimed the machine first, so
// the sample is skipped rather than taken through a tunnel.
const BASELINE_DELAY_MS = 4000;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(Activity.cancelled()); };
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(Activity.cancelled()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

class VpnCore extends EventEmitter {
  /**
   * @param {object} deps
   * -- collaborators (see index.cjs for the real ones) --
   * @param {object} deps.machine        ConnectionMachine
   * @param {object} deps.tunnel         Tunnel
   * @param {object} deps.telemetry      Telemetry
   * @param {object} deps.tunnelStatus   TunnelStatusTracker
   * @param {object} deps.killSwitch     KillSwitchGuard
   * @param {object} deps.systemProxy    SystemProxyController
   * @param {object} deps.health         HealthMonitor
   * @param {object} deps.failover       FailoverController
   * @param {object} deps.reconnectPolicy ReconnectPolicy
   * @param {object} deps.dispatcherHost DispatcherHost (read for status only)
   * -- the app's own knowledge --
   * @param {object}   deps.store
   * @param {function} deps.getSettings
   * @param {function} deps.findProfile
   * @param {function} deps.getRoutingPolicy
   * @param {function} [deps.getShieldKey]
   * @param {function} [deps.getFailoverCandidates]
   * @param {function} [deps.selectOnReconnect]  ({profileId, signal}) => id
   * -- capabilities --
   * @param {function} deps.findFreePort
   * @param {function} deps.proxyPing
   * @param {function} deps.testLocalProxy
   * @param {function} [deps.xrayExists]         () => boolean
   * @param {function} [deps.probeCadence]       (settings) => ms
   * @param {function} [deps.getTunnelDns]        (settings) => string[]|null
   * @param {function} [deps.reconcileStaleRoutes]
   * @param {function} [deps.teardownRoutes]
   * @param {function} [deps.recentLogs]
   * -- talking to the user --
   * @param {function} deps.notify
   * @param {function} deps.emit   (channel, payload) => void
   */
  constructor(deps) {
    super();
    Object.assign(this, {
      machine: deps.machine,
      tunnel: deps.tunnel,
      telemetry: deps.telemetry,
      tunnelStatus: deps.tunnelStatus,
      killSwitch: deps.killSwitch,
      systemProxy: deps.systemProxy,
      health: deps.health,
      failover: deps.failover,
      reconnectPolicy: deps.reconnectPolicy,
      dispatcherHost: deps.dispatcherHost,

      store: deps.store,
      getSettings: deps.getSettings,
      findProfile: deps.findProfile,
      getRoutingPolicy: deps.getRoutingPolicy,
      getShieldKey: deps.getShieldKey || (() => null),
      getFailoverCandidates: deps.getFailoverCandidates || (() => []),
      selectOnReconnect: deps.selectOnReconnect || (async ({ profileId }) => profileId),

      findFreePort: deps.findFreePort,
      proxyPing: deps.proxyPing,
      _testLocalProxy: deps.testLocalProxy,
      xrayExists: deps.xrayExists || (() => true),
      probeCadence: deps.probeCadence || (() => 8000),
      getTunnelDns: deps.getTunnelDns || (() => null),
      reconcileStaleRoutes: deps.reconcileStaleRoutes || (async () => 0),
      teardownRoutes: deps.teardownRoutes || (async () => {}),
      _recentLogs: deps.recentLogs || (() => []),

      notify: deps.notify || (() => {}),
      send: deps.emit || (() => {}),
      log: deps.log || (() => {}),
    });

    this.healthSession = null;
    this.retiring = false;
    this.missingBinaryMessage = deps.missingBinaryMessage || 'xray not found';

    this.tunnel.on('notice', ({ title, body }) => this.notify(title, body));
    this.tunnel.on('dropped', (session) => {
      this._handleDrop(session).catch((err) => this.log(`[vpn] drop handling failed: ${err.message}`));
    });
    this.machine.on('change', (change) => {
      this.log(`[vpn] ${change.from} -> ${change.to} (${change.reason})`);
      this.emit('changed');
    });
    this._wireHealth();
  }

  // ---- what the rest of the app reads ----

  get session() {
    return this.tunnel.active;
  }

  get state() {
    return this.machine.state;
  }

  get isConnected() {
    // Not `state === 'connected'`: during a "connect to the best server" sweep
    // the machine reports `connecting` while the previous tunnel is still up
    // and perfectly usable. Anything asking "can I send traffic through it
    // right now" wants the session, which is the thing that actually exists.
    return !!this.session;
  }

  snapshot() {
    return {
      connectionState: this.machine.state,
      connectedAt: this.session ? this.session.startedAt : null,
      dispatcherActive: this.dispatcherHost.active,
      systemProxy: this.systemProxy.status(),
      killSwitchBlocking: this.killSwitch.blocking,
    };
  }

  // ---- commands ----

  /**
   * Connect to one specific server. Cancels anything else in flight (a
   * countdown to an auto-reconnect, a selection sweep) because an explicit
   * choice supersedes whatever the app was about to do on its own.
   */
  async connect(profileId, { reason = 'user' } = {}) {
    const activity = this.machine.beginActivity('connect', reason);
    try {
      return await this._open(profileId, activity, reason);
    } finally {
      activity.end();
    }
  }

  /**
   * Connect to whatever `select` picks. The sweep runs *outside* the exclusive
   * section -- it can take ten seconds or more, and holding the connection lock
   * that long would block disconnect and leave the user unable to cancel -- but
   * inside an activity, so a disconnect aborts it instead of being overwritten
   * by the connect that used to follow regardless.
   *
   * @param {function} select ({ signal, activity }) => Promise<profileId>
   */
  async connectVia(select, { reason = 'select' } = {}) {
    const activity = this.machine.beginActivity('select', reason);
    const wasConnected = this.machine.state === 'connected';
    this.machine.to('connecting', { reason });
    try {
      const profileId = await select({ signal: activity.signal, activity });
      activity.throwIfCancelled();
      if (!profileId) throw new Error('سروری انتخاب نشد');
      return await this._open(profileId, activity, reason);
    } catch (err) {
      // _open() owns the state once it has started; a failure before that has
      // to put the machine back where it found it. If the previous tunnel is
      // still up, "back" is `connected`, not `disconnected`.
      if (this.machine.state === 'connecting') {
        if (wasConnected && this.session) this.machine.to('connected', { reason: `${reason}-kept` });
        else this.machine.to('disconnected', { reason: `${reason}-failed` });
      }
      throw err;
    } finally {
      activity.end();
    }
  }

  /**
   * Stop whatever the app was about to do on its own -- a selection sweep, a
   * pending auto-reconnect -- without touching a tunnel that is already up.
   * This is "cancel", not "disconnect".
   */
  cancelPending(reason = 'cancelled') {
    const cancelled = this.machine.cancelActivity(reason);
    // A sweep is the only thing that can leave the machine sitting in
    // `connecting` with nothing on the way; put it back where it belongs.
    if (cancelled && this.machine.state === 'connecting') {
      this.machine.to(this.session ? 'connected' : 'disconnected', { reason });
    }
    return cancelled;
  }

  async disconnect({ reason = 'user' } = {}) {
    // Before the lock, not inside it: the point is to stop work that has not
    // reached the lock yet.
    this.machine.cancelActivity(`disconnect:${reason}`);
    return this.machine.exclusive(async () => {
      if (!this.session && this.machine.isIdle) return;
      this.machine.to('disconnecting', { reason });
      await this._teardown(reason);
      this.machine.to('disconnected', { reason });
      await this.killSwitch.onSessionEnded();
    });
  }

  // ---- connecting, for real ----

  async _open(profileId, activity, reason) {
    const profile = this.findProfile(profileId);
    if (!profile) throw new Error('کانفیگ پیدا نشد');
    if (!this.xrayExists()) throw new Error(this.missingBinaryMessage);

    return this.machine.exclusive(async () => {
      // Queued behind something else that has since been cancelled by the user.
      activity.throwIfCancelled();

      const mode = this.connectionMode;
      // Announced before the old tunnel comes down, not after: the seconds
      // spent tearing it down are part of connecting, and reporting them as
      // "connected" would be a lie the UI acts on.
      this.machine.to('connecting', { reason });
      if (this.session) {
        await this._teardown();
        // The gap between two servers is still a gap. Kill Switch means no
        // traffic outside the tunnel, and a switch has no tunnel for a moment.
        await this.killSwitch.onSessionEnded();
      }

      const settings = this.getSettings();
      const routing = buildRoutingPlan(this.getRoutingPolicy(), mode);
      try {
        const ports = await allocatePorts({
          settings,
          useDispatcher: routing.useDispatcher,
          findFreePort: this.findFreePort,
        });
        const session = await this.tunnel.open({
          profile,
          mode,
          settings,
          ports,
          routing,
          shieldKey: this.getShieldKey(profile),
          dnsServers: this.getTunnelDns(settings),
        });

        // Cancelled while it was coming up. Bringing a tunnel up is the one
        // step that cannot be interrupted partway -- xray is either starting or
        // it isn't -- so the honest response is to take it straight back down,
        // rather than announce a connection the user has already asked to end
        // and leave the teardown to whatever runs next.
        if (!activity.live) {
          await this.tunnel.close();
          this.machine.to('disconnected', { reason: `${reason}-cancelled` });
          this.emit('changed');
          throw Activity.cancelled();
        }

        this.store.set('activeProfileId', profileId);
        this.store.set('activeMode', mode);
        this._stampLastUsed(profileId);

        this.machine.to('connected', { reason });
        this.reconnectPolicy.reset();
        await this._attachSubsystems(session, reason);
        this.notify('Soul Connection', `به «${profile.name}» متصل شدی`, 'connection');
        return session;
      } catch (err) {
        // A cancellation has already put everything back where it belongs, and
        // is not a failure to explain to the user.
        if (Activity.isCancellation(err)) throw err;
        this.machine.to('disconnected', { reason: `${reason}-failed` });
        // A half-built session may have left Windows pointed at a port that
        // never came up.
        await this._reconcileProxy('connect-failed');
        this.emit('changed');
        throw this.describeConnectError(err, mode);
      }
    });
  }

  async _teardown() {
    const session = this.session;
    this.retiring = true;
    try {
      // Withdraw BEFORE the listener dies: Windows pointed at a port that has
      // just stopped accepting connections means no internet at all. The user's
      // intent is left intact, so the next connect puts it straight back.
      await this._reconcileProxy('disconnect');
      this._detachSubsystems(session);
      await this.tunnel.close();
    } finally {
      this.retiring = false;
    }
  }

  /**
   * What Windows' proxy configuration should point at right now.
   *
   * `retiring` is the window between deciding to close a tunnel and having
   * closed it. The session object still exists throughout -- the teardown needs
   * it -- so asking "is there a session?" would answer yes and leave the proxy
   * pointed at a listener that is seconds from gone. This is the one place that
   * distinction is made, and the system proxy controller reads it on every
   * reconcile, including its own drift ticks.
   */
  proxyTarget() {
    if (this.retiring) return { connected: false };
    return systemProxyTarget(this.session, this.getSettings());
  }

  // ---- the session's entourage ----

  async _attachSubsystems(session, reason) {
    this.telemetry.attach(session);
    this.tunnelStatus.attach(session);
    this._updateHealth(session);
    this.emit('changed');
    // The tunnel is up, so honour the user's standing intent: if they asked for
    // the system to go through it, point Windows at the port we just bound.
    // Forced, because a reconnect can land on a different port than last time.
    await this._reconcileProxy(reason, true);
    await this.killSwitch.onConnected();
  }

  _detachSubsystems(session) {
    this._persistTraffic(session);
    this.telemetry.detach();
    this.tunnelStatus.attach(null);
    this._updateHealth(null);
  }

  _persistTraffic(session) {
    const moved = this.telemetry.takeTraffic();
    const total = moved.uplink + moved.downlink;
    if (!total || !session) return;
    const profiles = this.store.get('profiles', []);
    const profile = profiles.find((p) => p.id === session.profileId);
    if (!profile) return;
    profile.totalBytes = (profile.totalBytes || 0) + total;
    this.store.set('profiles', profiles);
  }

  _stampLastUsed(profileId) {
    const profiles = this.store.get('profiles', []);
    const p = profiles.find((x) => x.id === profileId);
    if (!p) return; // pool servers live outside the user's list
    p.lastUsedAt = Date.now();
    this.store.set('profiles', profiles);
  }

  // ---- the tunnel dropping on its own ----

  async _handleDrop(session) {
    this.machine.to('disconnected', { reason: 'drop' });
    this._detachSubsystems(session);
    // The tunnel died under it -- the dispatcher would keep accepting
    // connections and forwarding them into ports nothing is listening on, and
    // tunnel-mode routes would point into an adapter that no longer exists.
    await this.tunnel.cleanupAfterDrop();
    // The listener Windows was pointed at is gone, so the proxy has to come off
    // or the user has no internet while we retry. Intent is preserved, so a
    // successful reconnect re-applies it automatically.
    await this._reconcileProxy('drop');
    this.emit('changed');

    // Block immediately -- before any reconnect attempt -- so the gap while we
    // are retrying never leaks traffic. A successful reconnect lifts it again.
    await this.killSwitch.onSessionEnded();

    if (!this.getSettings().autoReconnect) {
      this.notify('اتصال قطع شد', 'تونل به‌طور غیرمنتظره قطع شد.', 'connection');
      return;
    }

    const profileId = session ? session.profileId : this.store.get('activeProfileId', null);
    const attempt = profileId ? this.reconnectPolicy.next() : null;
    if (!attempt) {
      this.notify('اتصال قطع شد', 'تلاش برای اتصال مجدد ناموفق بود.', 'connection');
      this.reconnectPolicy.reset();
      return;
    }

    this.notify('اتصال قطع شد', `در حال تلاش برای اتصال مجدد (${attempt.attempt}/${attempt.of})…`, 'connection');
    const activity = this.machine.beginActivity('reconnect', 'drop');
    try {
      // Cancellable, unlike the bare setTimeout this replaces: a user who
      // disconnected during the countdown used to get reconnected anyway,
      // because nothing re-checked their intent after the wait.
      await delay(attempt.delayMs, activity.signal);
      activity.throwIfCancelled();
      const target = await this.selectOnReconnect({ profileId, signal: activity.signal });
      activity.throwIfCancelled();
      await this._open(target || profileId, activity, 'reconnect');
    } catch (err) {
      if (Activity.isCancellation(err)) return;
      // xray's own exit event fires again on the next failure, and the attempt
      // cap above governs how often this repeats.
      this.log(`[vpn] reconnect failed: ${err.message}`);
    } finally {
      activity.end();
    }
  }

  // ---- health & failover ----

  _wireHealth() {
    this.health.on('active', (active) => this.send('health-update', { active }));
    this.health.on('backup', (backup) => this.send('health-update', { backup }));
    this.failover.on('degrading', (e) => this.send('failover-event', { phase: 'degrading', ...e }));
    this.failover.on('blocked', (e) => this.send('failover-event', { phase: 'blocked', ...e }));
    this.failover.on('switch', (e) => {
      this._performSwitch(e).catch((err) => this.log(`[vpn] failover switch failed: ${err.message}`));
    });
  }

  // The engine decided; performing the move is the core's job, because every
  // other connection state transition already goes through here.
  async _performSwitch({ candidate, reason, reasonText, candidateScore, currentScore }) {
    const from = this.findProfile(this.store.get('activeProfileId'));
    this.send('failover-event', {
      phase: 'switching',
      reason,
      reasonText,
      from: brief(from),
      to: brief(candidate),
      fromScore: currentScore,
      toScore: candidateScore,
    });
    try {
      await this.connect(candidate.id, { reason: 'failover' });
      const ev = this.failover.noteSwitchResult({ ok: true, fromProfile: from, toProfile: candidate, reason });
      this.notify('تعویض خودکار سرور', `${reasonText} — به «${candidate.name}» منتقل شدی`, 'failover');
      this.send('failover-event', { phase: 'done', ...ev, fromScore: currentScore, toScore: candidateScore });
    } catch (err) {
      const ev = this.failover.noteSwitchResult({
        ok: false, fromProfile: from, toProfile: candidate, reason, message: err.message,
      });
      this.send('failover-event', { phase: 'failed', ...ev });
    }
  }

  /**
   * Start, restart or stop health monitoring to match the live session. Keyed
   * on the session itself, so the rolling window is not reset by anything that
   * merely happens to broadcast state.
   */
  _updateHealth(session) {
    if (sameSession(this.healthSession, session)) return;
    this.healthSession = session;

    if (!session) {
      this.health.stop();
      this.failover.resetSession();
      return;
    }
    const s = this.getSettings();
    this.failover.resetSession();
    this.health.startActive({ intervalMs: this.probeCadence(s) });
    if (s.backupMonitoring && s.failoverEnabled) {
      this.health.startBackup({ getCandidates: () => this.getFailoverCandidates(MAX_FAILOVER_CANDIDATES) });
    } else {
      this.health.stopBackup();
    }
  }

  // Called when a setting that changes probe cadence or backup monitoring is
  // edited: the identity check above would otherwise keep the old timers
  // running until the next connect.
  restartHealth() {
    this.healthSession = null;
    this._updateHealth(this.session);
  }

  healthSnapshot() {
    return {
      active: this.health.activeHealth(),
      backup: this.health.backupSnapshot(),
      failover: this.failover.snapshot(),
    };
  }

  // The probe the health monitor runs against the live tunnel. Deliberately
  // aimed at xray's own inbound rather than the public port -- see endpoints.
  probeLiveTunnel() {
    const session = this.session;
    if (!session) return Promise.resolve(-1);
    return this.proxyPing(probeTarget(session, this.getSettings()));
  }

  // ---- system proxy ----

  // Fire-and-forget: no caller should ever be blocked on, or able to fail
  // because of, a registry reconcile.
  _reconcileProxy(reason, force = false) {
    return this.systemProxy.reconcile({ reason, force }).catch((err) => {
      this.log(`[system-proxy] reconcile failed: ${err.message}`);
      return this.systemProxy.status();
    });
  }

  syncSystemProxy(reason, force = false) {
    return this._reconcileProxy(reason, force);
  }

  // ---- odds and ends the IPC layer needs ----

  get connectionMode() {
    return this.store.get('connectionMode', 'proxy');
  }

  set connectionMode(mode) {
    this.store.set('connectionMode', mode);
  }

  // Does the rule set xray is running differ from the one the current policy
  // would produce? Only that needs a reconnect -- app rules live entirely in
  // the dispatcher, which reads the policy fresh on every connection.
  routingSignature() {
    return planSignature(buildRoutingPlan(this.getRoutingPolicy(), this.connectionMode));
  }

  routingState() {
    const policy = this.getRoutingPolicy();
    return {
      mode: policy.mode,
      lanDirect: policy.lanDirect,
      rules: policy.rules,
      dispatcherActive: this.dispatcherHost.active,
      dispatcherNeeded: this.dispatcherHost.neededFor(policy),
      stats: this.dispatcherHost.stats,
    };
  }

  // A real measurement of the live tunnel, for the ping button.
  async pingLiveTunnel({ samples = 3, timeoutMs = 6000 } = {}) {
    const target = probeTarget(this.session, this.getSettings());
    if (!target) return null;
    const out = [];
    for (let i = 0; i < samples; i++) {
      out.push(await this.proxyPing(target, timeoutMs));
      // The tunnel isn't passing traffic; don't wait out two more timeouts.
      if (out.some((s) => s < 0)) break;
    }
    return out;
  }

  testLocalProxy(protocol) {
    const target = localProxyTarget(this.session, this.getSettings(), protocol);
    if (!target) {
      return Promise.resolve({ ok: false, reason: 'not-running', message: 'پروکسی محلی در حال اجرا نیست' });
    }
    return this._testLocalProxy(target);
  }

  recentLogs() {
    return this._recentLogs();
  }

  // Turn a failure into something the user can act on. Overridden by the
  // composition root, which knows the platform-specific wording.
  describeConnectError(err) {
    return err;
  }

  // ---- startup & shutdown ----

  /**
   * Bring the machine back to a sane state after a crash, a force-quit, or a
   * power loss while connected: a stranded system proxy or a stranded pair of
   * /1 routes both leave the user with no internet at all, and by definition
   * none of those endings ran the normal teardown.
   */
  async recoverFromUnclean() {
    await this.killSwitch.syncAtStartup();
    this._reconcileProxy('startup');
    try {
      const removed = await this.reconcileStaleRoutes();
      if (removed) this.log(`[tun] removed ${removed} stale route(s)`);
    } catch { /* best effort */ }

    // Sample this machine's own public address, but only once launch has
    // settled and only if nothing has connected in the meantime: a reading
    // taken with a tunnel up -- or worse, with tunnel-mode routes installed
    // halfway through the request -- is the tunnel's own address masquerading
    // as the baseline, which is the one thing the baseline exists to rule out.
    const timer = setTimeout(() => {
      if (!this.session && this.machine.isIdle) this.tunnelStatus.refreshBaseline();
    }, BASELINE_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  /**
   * Last-ditch teardown for quit and update-install paths. Capped by the
   * caller: an app that cannot be closed because a registry call hung is worse
   * than a proxy left behind (which the next launch reconciles anyway).
   */
  async shutdown() {
    this.machine.cancelActivity('shutdown');
    this.systemProxy.stop();
    try {
      if (this.session || !this.machine.isIdle) await this.disconnect({ reason: 'shutdown' });
    } catch { /* still have to clean up below */ }
    await this.systemProxy.withdrawForShutdown();
    try { await this.teardownRoutes(); } catch { /* nothing left to tear down */ }
  }
}

const brief = (p) => (p ? { id: p.id, name: p.name, address: p.address } : null);

module.exports = { VpnCore, MAX_FAILOVER_CANDIDATES, delay };
