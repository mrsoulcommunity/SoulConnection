import { useCallback, useEffect, useMemo, useState } from 'react';
import { resetTelemetry } from '../telemetryStore.js';

// ---- The renderer's mirror of the main process ----
//
// Every piece of state that main owns and pushes arrives through exactly one
// place: this hook. It plays the same role for the renderer that `session.cjs`
// plays inside the VPN core -- everything else *follows* it. The action hooks
// (useConnection, useLibrary, ...) never subscribe to a channel themselves;
// they call an IPC endpoint and write what main answered back through the
// `set` bundle so there is never a second copy of the truth drifting on its
// own timer.
//
// What is deliberately NOT here:
//   - `latencyMs` / `traffic` -- see telemetryStore.js. They arrive on a timer
//     for the whole life of a connection, and holding them in React state at
//     the root meant re-rendering the entire app once a second for two numbers
//     in the footer.
//   - ping readings -- see usePings.js, which coalesces a sweep's writes to
//     one render per animation frame.
export default function useMainState() {
  const [profiles, setProfiles] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [connectionMode, setConnectionMode] = useState('proxy');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [connectedAt, setConnectedAt] = useState(null);
  const [settings, setSettings] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  // One snapshot of the whole update protocol, pushed by the main process on
  // every change. Nothing about updates is tracked separately in the renderer
  // -- there is one source of truth and it lives in electron/lib/update.
  const [updaterStatus, setUpdaterStatus] = useState(null);
  // Adaptive Shield: `shield` is the settled state (mode, active treatment,
  // last measurement) and `shieldProgress` is the live sweep, which only
  // exists while a tune is running.
  const [shield, setShield] = useState(null);
  const [shieldProgress, setShieldProgress] = useState(null);
  // Soul Connection pool: `soulMode` is the selection, `soulProgress` is the
  // live sweep readout (null whenever nothing is running).
  const [soulMode, setSoulMode] = useState(false);
  const [soulCount, setSoulCount] = useState(0);
  const [soulProgress, setSoulProgress] = useState(null);
  const [activeSoulProfile, setActiveSoulProfile] = useState(null);
  // Registry-verified system-proxy status from main, never a local guess.
  // `desired` is the user's standing intent, `active` is what Windows really
  // has right now -- the UI must never conflate them.
  const [systemProxy, setSystemProxy] = useState({ desired: false, active: false, pending: false });
  const [killSwitchBlocking, setKillSwitchBlocking] = useState(false);
  // Smart Routing / health / failover. `routingNeedsReconnect` is sticky until
  // the next connect: a domain-rule change only reaches xray when the tunnel is
  // rebuilt, and the user has to be told rather than left wondering why the
  // rule they just wrote isn't doing anything yet.
  const [routing, setRouting] = useState(null);
  const [routingNeedsReconnect, setRoutingNeedsReconnect] = useState(false);
  const [health, setHealth] = useState(null);
  const [failover, setFailover] = useState(null);
  const [failoverEvent, setFailoverEvent] = useState(null);

  const refresh = useCallback(async () => {
    const data = await window.soul.listProfiles();
    setProfiles(data.profiles);
    setSubscriptions(data.subscriptions);
    setActiveProfileId(data.activeProfileId);
    setConnectionMode(data.connectionMode);
    setConnectionState(data.connectionState);
    setConnectedAt(data.connectedAt);
    setSettings(data.settings);
    if (data.systemProxy) setSystemProxy(data.systemProxy);
    setKillSwitchBlocking(!!data.killSwitchBlocking);
    setSoulMode(!!data.soulModeEnabled);
    setSoulCount(data.soulCount || 0);
    setActiveSoulProfile(data.activeSoulProfile || null);
    if (data.routing) setRouting(data.routing);
    if (data.health) setHealth(data.health);
    if (data.failover) setFailover(data.failover);
  }, []);

  // Warm the pool list in the background on first paint so the sidebar can
  // show a real server count, and so the first connect skips the fetch.
  useEffect(() => {
    let cancelled = false;
    window.soul.soulList?.()
      .then((r) => { if (!cancelled && r) setSoulCount(r.count); })
      .catch(() => { /* offline; the count just stays at 0 until connect */ });
    return () => { cancelled = true; };
  }, []);

  // System proxy has its own push channel because it changes for reasons the
  // connection state knows nothing about: the drift watcher noticing the user
  // (or another app) altered Windows' settings behind our back.
  useEffect(() => {
    const off = window.soul.onSystemProxyStatus?.((s) => setSystemProxy(s));
    window.soul.systemProxyGet?.().then((s) => { if (s) setSystemProxy(s); }).catch(() => {});
    // Coming back to the window is the likeliest moment for the user to have
    // just changed something in Internet Options, so re-read then too.
    const onFocus = () => { window.soul.systemProxyGet?.().then((s) => { if (s) setSystemProxy(s); }).catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => { if (off) off(); window.removeEventListener('focus', onFocus); };
  }, []);

  useEffect(() => {
    refresh();
    window.soul.getAppInfo().then(setAppInfo).catch(() => {});
    const offState = window.soul.onStateChanged(({ connectionState, activeProfileId, connectedAt, systemProxy: sp, killSwitchBlocking, soulModeEnabled, activeSoulProfile }) => {
      setConnectionState(connectionState);
      setActiveProfileId(activeProfileId);
      setConnectedAt(connectedAt);
      if (sp) setSystemProxy(sp);
      setKillSwitchBlocking(!!killSwitchBlocking);
      setSoulMode(!!soulModeEnabled);
      setActiveSoulProfile(activeSoulProfile || null);
      if (connectionState === 'connected') {
        // A fresh tunnel was built from the current rules, so whatever was
        // pending has now been applied.
        setRoutingNeedsReconnect(false);
      } else {
        // The readings belong to a tunnel that no longer exists. Leaving them
        // on screen is how a footer comes to report a live speed for a session
        // that has ended.
        resetTelemetry();
        setHealth(null);
        refresh(); // picks up the just-persisted lifetime usage total
      }
    });
    const offSoul = window.soul.onSoulProgress?.((p) => {
      setSoulProgress(p);
      // 'done' leaves the winning server on screen; a cancel (error with no
      // message) just clears the row back to its idle state.
      if (p.phase === 'error' && !p.message) setSoulProgress(null);
    });
    const offRouting = window.soul.onRoutingChanged?.((state) => {
      setRouting(state);
      if (state.needsReconnect) setRoutingNeedsReconnect(true);
    });
    const offHealth = window.soul.onHealthUpdate?.((patch) => {
      setHealth((prev) => ({ ...prev, ...patch }));
    });
    const offFailover = window.soul.onFailoverEvent?.((e) => {
      // 'degrading' is the engine counting bad checks -- useful telemetry, but
      // not something to interrupt the user with until it actually acts.
      if (e.phase === 'degrading') return;
      if (e.phase === 'blocked') return;
      setFailoverEvent(e);
      if (e.phase === 'done' || e.phase === 'failed') {
        window.soul.getHealth?.().then((h) => h && setFailover(h.failover)).catch(() => {});
      }
    });
    const offProfiles = window.soul.onProfilesChanged(() => refresh());
    // Seed from the current state so a window opened mid-download shows the
    // download, then follow the push channel.
    window.soul.updaterState?.().then((s) => { if (s) setUpdaterStatus(s); }).catch(() => {});
    const offUpdater = window.soul.onUpdaterStatus((s) => setUpdaterStatus(s));

    window.soul.shieldState?.().then((s) => { if (s) setShield(s); }).catch(() => {});
    const offShield = window.soul.onShieldProgress?.((p) => {
      setShieldProgress(p);
      // The sweep finishing is also when the stored choice changes, so re-read
      // the settled state rather than trying to derive it from the event.
      if (p.phase === 'done' || !p.running) {
        window.soul.shieldState?.().then((s) => { if (s) setShield(s); }).catch(() => {});
      }
    });
    return () => {
      offState(); offProfiles(); offUpdater();
      if (offShield) offShield();
      if (offSoul) offSoul();
      if (offRouting) offRouting();
      if (offHealth) offHealth();
      if (offFailover) offFailover();
    };
  }, [refresh]);

  // A completed switch has told its story after a while; a failed one stays
  // until dismissed, because it means the user is probably still offline.
  useEffect(() => {
    if (failoverEvent?.phase !== 'done') return;
    const t = setTimeout(() => setFailoverEvent(null), 20000);
    return () => clearTimeout(t);
  }, [failoverEvent]);

  // React state setters are identity-stable, so this bundle is built once and
  // stays the same object for the app's life -- action hooks can list it in
  // their useCallback deps without ever invalidating them.
  const set = useMemo(() => ({
    setProfiles,
    setSubscriptions,
    setActiveProfileId,
    setConnectionMode,
    setSettings,
    setSystemProxy,
    setKillSwitchBlocking,
    setSoulMode,
    setSoulCount,
    setSoulProgress,
    setActiveSoulProfile,
    setRouting,
    setRoutingNeedsReconnect,
    setHealth,
    setFailoverEvent,
    setShield,
    setShieldProgress,
  }), []);

  return {
    profiles,
    subscriptions,
    activeProfileId,
    connectionMode,
    connectionState,
    connectedAt,
    settings,
    appInfo,
    updaterStatus,
    shield,
    shieldProgress,
    soulMode,
    soulCount,
    soulProgress,
    activeSoulProfile,
    systemProxy,
    killSwitchBlocking,
    routing,
    routingNeedsReconnect,
    health,
    failover,
    failoverEvent,
    refresh,
    set,
  };
}
