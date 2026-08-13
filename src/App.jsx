import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import StatusBar from './components/StatusBar.jsx';
import SettingsView from './components/SettingsView.jsx';
import ServerFinder from './components/ServerFinder.jsx';
import SoulPoolEntry from './components/SoulPoolEntry.jsx';
import RoutingRules from './components/RoutingRules.jsx';
import { FailoverStatus } from './components/FailoverSettings.jsx';
import TunnelStatus from './components/TunnelStatus.jsx';
import UpdateCard from './components/UpdateCard.jsx';
import Icon from './components/Icon.jsx';
import { loadSession, saveSession, clearSession } from './utils/sessionState.js';
import { pingMs, toEntry } from './utils/ping.js';
import { createRafBatch } from './utils/rafBatch.js';
import { resetTelemetry } from './telemetryStore.js';

const PING_CONCURRENCY = 12;

// Custom chrome for the frameless window. Standard Windows layout: app
// icon/name at the top-left, minimize/maximize/close at the top-right in
// that order (close outermost) -- `.titlebar` forces `direction: ltr` in CSS
// so this physical layout holds regardless of the app's own RTL content.
function TitleBar({ maximized, onMinimize, onToggleMaximize, onClose }) {
  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <img src="./icon.png" alt="" />
        <span>Soul Connection</span>
      </div>
      <div className="titlebar-drag" onDoubleClick={onToggleMaximize} />
      <div className="titlebar-controls">
        <button className="tb-btn" onClick={onMinimize} title="کوچک‌کردن">
          <Icon name="winMinimize" size={13} />
        </button>
        <button className="tb-btn" onClick={onToggleMaximize} title={maximized ? 'بازگردانی' : 'بیشینه‌سازی'}>
          <Icon name={maximized ? 'winRestore' : 'winMaximize'} size={12} />
        </button>
        <button className="tb-btn close" onClick={onClose} title="بستن">
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

// Hoisted out of the component so they are the same function on every render.
// They close over nothing, and passing fresh arrows instead would defeat the
// React.memo on the cards that receive them.
const downloadAndInstall = () => window.soul.downloadAndInstall();
const installUpdate = () => window.soul.installUpdate();
const cancelUpdateDownload = () => window.soul.cancelUpdateDownload?.();
const cancelAutoInstall = () => window.soul.cancelAutoInstall?.();

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [connectionMode, setConnectionMode] = useState('proxy');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [connectedAt, setConnectedAt] = useState(null);
  // `latencyMs` and `traffic` are deliberately NOT here -- see telemetryStore.js.
  // They arrive on a timer for the whole life of a connection, and holding them
  // in App state meant re-rendering the entire app once a second for two numbers
  // in the footer.
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
  const [soulRefreshing, setSoulRefreshing] = useState(false);
  // The version the sidebar card was dismissed for. Kept per-version so a
  // later release re-opens the card instead of inheriting an old "not now".
  const [updateDismissed, setUpdateDismissed] = useState(null);
  // ---- Ping results, published one frame at a time ----
  //
  // A sweep runs PING_CONCURRENCY measurements at once and each one wants to
  // write twice (a "measuring" mark, then the reading). Applied individually
  // that is up to a thousand renders over a few seconds, each one rebuilding
  // the whole sidebar -- during the exact stretch the user is watching a
  // spinner. So the truth lives in a ref, written synchronously, and is
  // published to state at most once per animation frame. Nothing is dropped;
  // only the renders between frames are.
  const pingsRef = useRef({});
  const [pings, setPings] = useState(pingsRef.current);
  // The live batch measurement, or null. See handlePingAll.
  const sweepStateRef = useRef(null);
  const [pingSweep, setPingSweep] = useState(null);
  // The cancellation token of the sweep in flight -- separate from the readout
  // above, because the stop button has to reach it without a re-render.
  const pingSweepRef = useRef(null);
  const [showAdd, setShowAdd] = useState(false);
  // Seeded eagerly (before `settings` loads) from whatever was last saved --
  // if "Restore Previous Session" turns out to be off, the effect below
  // wipes the stored session so the NEXT launch starts clean. A one-time
  // restore before that check resolves is a harmless, self-correcting edge
  // case, not worth delaying the sidebar's first render to avoid.
  const sessionRef = useRef(loadSession() || {});
  const [tab, setTab] = useState(() => sessionRef.current.tab || 'servers');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updatingSubs, setUpdatingSubs] = useState(false);
  const [refreshingSubIds, setRefreshingSubIds] = useState(() => new Set());
  const [finderOpen, setFinderOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
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

  // ---- One connection phase for the whole home screen ----
  //
  // `connectionState` is main's view, and only part of the truth: it stays
  // 'disconnected' for the entire window in which the renderer has a connect
  // call in flight or a Soul pool sweep is running. That window is exactly
  // where the hero used to offer an enabled button whose handler returned on
  // `if (busy) return`, and where the pool row disabled its own cancel. Folding
  // the in-flight signals into one phase (see `heroPhase` below) is what stops
  // the hero, the rail and the sidebar from being able to contradict each
  // other. Derived, never stored -- this adds no new source of truth.
  const soulSweeping = !!soulProgress
    && ['fetching', 'probing', 'testing', 'connecting'].includes(soulProgress.phase);
  // A sweep in any of its phases can be called off, not just once main has
  // reached 'connecting'. Until this covered the earlier phases there was a
  // stretch of several seconds with no way to stop a running sweep.
  const soulCancelable = soulSweeping || connectionState === 'connecting';

  useEffect(() => {
    window.soul.windowIsMaximized?.().then(setWindowMaximized).catch(() => {});
    const off = window.soul.onWindowState?.(({ maximized }) => setWindowMaximized(maximized));
    return () => off && off();
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

  const showAddRef = useRef(showAdd);
  useEffect(() => { showAddRef.current = showAdd; }, [showAdd]);

  // Every global shortcut has to answer the same question before it fires: is
  // the user typing into something, or does a modal already own the screen?
  // That rule was written out for Ctrl+V and not at all for Ctrl+K, which is
  // why Ctrl+F inside the sidebar's own search box opened the finder, and why
  // Ctrl+K could open the finder *behind* a modal that was already up.
  const shortcutBlocked = useCallback((e) => {
    const t = e.target;
    if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return true;
    if (showAddRef.current) return true;
    return document.body.dataset.modalOpen === 'true';
  }, []);

  // Ctrl+K (or Ctrl+F) opens the server finder from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'k' && k !== 'f') return;
      // Closing is always allowed: the finder's own search box is an input, so
      // the guard would otherwise trap the user inside the thing they opened.
      if (!finderOpen && shortcutBlocked(e)) return;
      e.preventDefault();
      setFinderOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finderOpen, shortcutBlocked]);

  // Global Ctrl+V: smart-detect clipboard content (config link vs subscription
  // URL) and add it, unless the user is pasting into a real field/modal.
  useEffect(() => {
    const onKey = async (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
      if (finderOpen || shortcutBlocked(e)) return;

      e.preventDefault();
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showToast('دسترسی به کلیپ‌بورد ممکن نشد', 'error');
        return;
      }
      text = (text || '').trim();
      if (!text) return;

      try {
        // Look for a config prefix ANYWHERE in the paste, not just at the
        // very start -- a multi-config paste can have a leading blank line,
        // a label, or other text before the first real link.
        if (/(vmess|vless|trojan|ss):\/\//i.test(text)) {
          await handleAddLink(text);
        } else if (/^https?:\/\//i.test(text)) {
          await handleAddSubscription(text);
        } else {
          showToast('محتوای کلیپ‌بورد یک کانفیگ یا لینک سابسکریپشن معتبر نیست', 'error');
        }
      } catch (err) {
        showToast(err.message || 'خطا در افزودن از کلیپ‌بورد', 'error');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finderOpen, shortcutBlocked]);

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
    const offOpenSettings = window.soul.onOpenSettings(() => setTab('settings'));
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
      offState(); offProfiles(); offOpenSettings(); offUpdater();
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

  // ---- The motion preference ----
  //
  // Two independent triggers -- Windows' own "show animations" setting and the
  // app's own toggle -- and one outcome, so the OR is computed here and put on
  // <html> as a class. CSS cannot set a class from a media query, and the
  // alternative (a `prefers-reduced-motion` block plus a duplicate class block)
  // means keeping forty rules in sync by hand. Applied to the document root
  // rather than threaded through props because the rules that read it are
  // spread across every screen in the app.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      document.documentElement.classList.toggle(
        'reduce-motion',
        settings?.reduceMotion === true || mq.matches
      );
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.reduceMotion]);

  // "Restore Previous Session": persist the active tab whenever it changes,
  // but only while the setting is on -- and wipe any stored session the
  // moment it's turned off, so a disabled toggle actually stays disabled.
  useEffect(() => {
    if (!settings) return;
    if (!settings.restorePreviousSession) {
      clearSession();
      return;
    }
    saveSession({ ...sessionRef.current, tab });
  }, [tab, settings]);

  // Debounced report from ServerList of query/sortBy/collapsed -- merged
  // into the same stored session object as `tab`.
  const handleSessionChange = useCallback((partial) => {
    sessionRef.current = { ...sessionRef.current, ...partial };
    if (settings?.restorePreviousSession) saveSession({ ...sessionRef.current, tab });
  }, [tab, settings]);

  // Stabilized with useCallback: these flow into React.memo'd children
  // (ServerCard via ServerList, ConnectHero, StatusBar) that sit in the
  // hottest paths (ping-all, 1s traffic ticks) -- a fresh function reference
  // every App render would defeat memoization and re-render the whole tree.
  // The dismiss timer is tracked so a second toast restarts the countdown --
  // otherwise the previous toast's timer fires mid-life and clears the new one
  // early (very visible in flows that toast twice in a row, like add + connect).
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 2600);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const handleToggleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (connectionState === 'connected' || connectionState === 'connecting') {
        await window.soul.disconnect();
      } else if (soulMode) {
        // The pool picks the server; this is the whole point of the mode.
        setSoulProgress({ phase: 'fetching' });
        await window.soul.soulConnectBest();
      // `> 0`, not `> 1`: with a single config "choose the best" trivially
      // chooses it. Requiring two made the hero offer automatic selection and
      // then answer the click with "pick a config first".
      } else if (settings?.autoSelectBestServer && profiles.length > 0) {
        // "Let it choose" is exactly what the toggle asks for. Clicking a
        // specific server in the sidebar still connects to that one.
        const r = await window.soul.connectBest();
        if (r?.profile) showToast(`بهترین سرور انتخاب شد: ${r.profile.name}`);
      } else {
        if (!activeProfileId) {
          showToast('اول یک کانفیگ را انتخاب کن', 'error');
          setBusy(false);
          return;
        }
        await window.soul.connect(activeProfileId);
      }
    } catch (err) {
      showToast(err.message || 'خطا در اتصال', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, connectionState, activeProfileId, soulMode, settings, profiles.length, showToast]);

  // ---- Smart Routing ----
  //
  // Every mutation answers with the whole routing state, so the UI never has to
  // guess what the main process did with the rule it just sent (normalization
  // rewrites exe paths and domain forms) -- it just renders what came back.
  const applyRouting = useCallback((state) => {
    if (!state) return;
    setRouting(state);
    if (state.needsReconnect) setRoutingNeedsReconnect(true);
  }, []);

  const handleSetRoutingMode = useCallback(async (mode) => {
    try {
      applyRouting(await window.soul.routingSetMode(mode));
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت مسیریابی', 'error');
    }
  }, [applyRouting, showToast]);

  const handleSetLanDirect = useCallback(async (enabled) => {
    try {
      applyRouting(await window.soul.routingSetLanDirect(enabled));
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره', 'error');
    }
  }, [applyRouting, showToast]);

  // Rethrows: the rule modal keeps itself open and shows the validation error
  // inline instead of closing over a change that never happened.
  const handleSaveRule = useCallback(async (rule) => {
    try {
      applyRouting(await window.soul.routingSaveRule(rule));
    } catch (err) {
      showToast(err.message || 'قانون ذخیره نشد', 'error');
      throw err;
    }
  }, [applyRouting, showToast]);

  const handleDeleteRule = useCallback(async (id) => {
    try {
      applyRouting(await window.soul.routingDeleteRule(id));
    } catch (err) {
      showToast(err.message || 'حذف نشد', 'error');
    }
  }, [applyRouting, showToast]);

  const handleToggleRule = useCallback(async (id, enabled) => {
    try {
      applyRouting(await window.soul.routingToggleRule(id, enabled));
    } catch (err) {
      showToast(err.message || 'خطا', 'error');
    }
  }, [applyRouting, showToast]);

  const handleAddDomains = useCallback(async (payload) => {
    try {
      applyRouting(await window.soul.routingAddDomains(payload));
      showToast('دامنه‌ها اضافه شدند');
    } catch (err) {
      showToast(err.message || 'افزوده نشد', 'error');
      throw err;
    }
  }, [applyRouting, showToast]);

  const handleReconnect = useCallback(async () => {
    if (busy || !activeProfileId) return;
    setBusy(true);
    try {
      await window.soul.connect(activeProfileId);
      setRoutingNeedsReconnect(false);
    } catch (err) {
      showToast(err.message || 'خطا در اتصال مجدد', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, activeProfileId, showToast]);

  // Selecting the pool row. Toggling it off falls back to manual selection;
  // doing either mid-sweep cancels the sweep rather than queueing behind it.
  const handleSoulSelect = useCallback(async () => {
    try {
      if (soulCancelable) {
        await window.soul.soulCancel();
        setSoulProgress(null);
        return;
      }
      const next = !soulMode;
      await window.soul.soulSetEnabled(next);
      setSoulMode(next);
      if (!next) setSoulProgress(null);
    } catch (err) {
      showToast(err.message || 'خطا', 'error');
    }
  }, [soulMode, soulCancelable, showToast]);

  const handleSoulRefresh = useCallback(async () => {
    setSoulRefreshing(true);
    try {
      const r = await window.soul.soulList(true);
      setSoulCount(r.count);
      showToast(`${r.count} سرور سول کانکشن به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در دریافت فهرست', 'error');
    } finally {
      setSoulRefreshing(false);
    }
  }, [showToast]);

  const handleSelect = useCallback(async (id) => {
    // Picking a server by hand leaves pool mode. Main does the same on its
    // side when connecting, but this keeps the sidebar honest while idle.
    if (soulMode) {
      setSoulMode(false);
      setSoulProgress(null);
      window.soul.soulSetEnabled(false).catch(() => {});
    }
    if (connectionState === 'connected' || connectionState === 'connecting') {
      setBusy(true);
      try {
        await window.soul.connect(id);
      } catch (err) {
        showToast(err.message || 'خطا در اتصال', 'error');
      } finally {
        setBusy(false);
      }
    } else {
      setActiveProfileId(id);
    }
  }, [connectionState, soulMode, showToast]);

  const handleDelete = useCallback(async (id) => {
    const updated = await window.soul.deleteProfile(id);
    setProfiles(updated);
    setActiveProfileId((cur) => (cur === id ? null : cur));
  }, []);

  const handleRenameProfile = useCallback(async (id, name) => {
    const updated = await window.soul.renameProfile(id, name);
    setProfiles(updated);
  }, []);

  const handleEditProfile = useCallback(async (id, link) => {
    const updated = await window.soul.updateProfile(id, link);
    setProfiles(updated);
    showToast('کانفیگ به‌روزرسانی شد');
  }, [showToast]);

  // The one place ping state reaches React. Everything above it writes the ref
  // synchronously and asks for a frame; this hands both readouts to React
  // together, so a sweep costs one render per frame instead of two per server.
  const publishPings = useCallback(() => {
    setPings({ ...pingsRef.current });
    setPingSweep(sweepStateRef.current ? { ...sweepStateRef.current } : null);
  }, []);
  const pingFrame = useMemo(() => createRafBatch(publishPings), [publishPings]);
  useEffect(() => () => pingFrame.cancel(), [pingFrame]);

  // `undefined` removes the row's reading rather than storing an empty one --
  // that is what restores a cancelled measurement to "never measured".
  const writePing = useCallback((id, entry) => {
    if (entry === undefined) delete pingsRef.current[id];
    else pingsRef.current[id] = entry;
    pingFrame.schedule();
  }, [pingFrame]);

  // Keeps the previous reading visible while a new one is in flight, so a
  // re-ping doesn't blank the row out and shift the layout under the cursor.
  const handlePing = useCallback(async (id, token) => {
    // `method` rides along so the "measured through the tunnel" marker doesn't
    // blink off and back on during a re-measure of the connected server.
    const previous = pingsRef.current[id];
    writePing(id, { status: 'measuring', prev: pingMs(previous), method: previous?.method });
    try {
      const result = await window.soul.pingTest(id, token);
      // Abandoned by a stop button. The server was not measured and did not
      // fail -- marking the row red would be inventing a result, so it goes
      // back to whatever it showed before.
      if (result && result.cancelled) {
        writePing(id, previous);
        return null;
      }
      const entry = toEntry(result);
      writePing(id, entry);
      return pingMs(entry) ?? -1;
    } catch (err) {
      writePing(id, { status: 'fail', message: err.message, at: Date.now() });
      return -1;
    }
  }, [writePing]);

  // A sweep is a whole batch of measurements, and the user watching it wants
  // three things the old version never told them: how far along it is, how it
  // turned out, and how to stop it. `pingSweepRef` holds the live token so the
  // cancel button can reach it without re-rendering every card on each tick.
  const handlePingAll = useCallback(async (ids) => {
    if (pingSweepRef.current || !ids.length) return;
    const token = { cancelled: false, id: `sweep-${Date.now()}` };
    pingSweepRef.current = token;
    sweepStateRef.current = {
      total: ids.length, done: 0, ok: 0, best: null, running: true, cancelled: false,
    };
    pingFrame.schedule();
    try {
      await mapWithConcurrency(ids, PING_CONCURRENCY, async (id) => {
        // Cancelling stops the queue; measurements already in flight are left
        // to finish, because the main process has no way to abort one midway
        // and pretending otherwise would leave their rows spinning forever.
        if (token.cancelled) return;
        const ms = await handlePing(id, token.id);
        // null means it was abandoned mid-measurement: it counts towards
        // neither the measured tally nor the failures.
        if (ms == null) return;
        const s = sweepStateRef.current;
        if (!s) return; // dismissed mid-sweep
        s.done += 1;
        if (ms >= 0) {
          s.ok += 1;
          if (s.best == null || ms < s.best) s.best = ms;
        }
        pingFrame.schedule();
      });
    } finally {
      pingSweepRef.current = null;
      if (sweepStateRef.current) {
        sweepStateRef.current.running = false;
        sweepStateRef.current.cancelled = token.cancelled;
      }
      pingFrame.schedule();
    }
  }, [handlePing, pingFrame]);

  // Stops the queue AND abandons the dozen measurements already running, so
  // "stopping" takes about as long as it says rather than quietly finishing the
  // batch. Rows that were mid-measurement revert to their previous reading.
  const handleCancelPingAll = useCallback(() => {
    const token = pingSweepRef.current;
    if (!token) return;
    token.cancelled = true;
    if (sweepStateRef.current) sweepStateRef.current.cancelled = true;
    pingFrame.schedule();
    window.soul.pingCancel?.(token.id).catch(() => {});
  }, [pingFrame]);

  const handleDismissPingSweep = useCallback(() => {
    sweepStateRef.current = null;
    pingFrame.schedule();
  }, [pingFrame]);

  // Connect regardless of current state (used by the finder's result cards).
  const handleConnectTo = useCallback(async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.soul.connect(id);
    } catch (err) {
      showToast(err.message || 'خطا در اتصال', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  const handleDisconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.soul.disconnect();
    } catch (err) {
      showToast(err.message || 'خطا در قطع اتصال', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  const handleToggleFavorite = useCallback(async (profile) => {
    try {
      const updated = await window.soul.setFavorite(profile.id, !profile.favorite);
      setProfiles(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره', 'error');
    }
  }, [showToast]);

  const handleAddLink = useCallback(async (link) => {
    const { profiles: added, duplicates } = await window.soul.addLink(link);
    await refresh();
    setShowAdd(false);
    const dupNote = duplicates > 0 ? ` (${duplicates} مورد تکراری نادیده گرفته شد)` : '';
    showToast(added.length > 1 ? `${added.length} کانفیگ اضافه شد${dupNote}` : `کانفیگ اضافه شد${dupNote}`);
  }, [refresh, showToast]);

  const handleAddSubscription = useCallback(async (url) => {
    const { profiles: added } = await window.soul.addSubscription(url);
    await refresh();
    setShowAdd(false);
    showToast(`${added.length} کانفیگ از ساب‌اسکریپشن اضافه شد`);
  }, [refresh, showToast]);

  const handleAddCustom = useCallback(async (fields) => {
    await window.soul.addCustomConfig(fields);
    await refresh();
    setShowAdd(false);
    showToast('کانفیگ اضافه شد');
  }, [refresh, showToast]);

  const handleRefreshSubscription = useCallback(async (id) => {
    if (refreshingSubIds.has(id)) return; // already refreshing -- ignore repeat clicks
    setRefreshingSubIds((prev) => new Set(prev).add(id));
    try {
      const { profiles: added } = await window.soul.refreshSubscription(id);
      await refresh();
      showToast(`${added.length} کانفیگ به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی', 'error');
    } finally {
      setRefreshingSubIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [refresh, showToast, refreshingSubIds]);

  const handleUpdateAllSubscriptions = useCallback(async () => {
    if (updatingSubs) return;
    setUpdatingSubs(true);
    try {
      await window.soul.refreshAllSubscriptions();
      await refresh();
      showToast('همه‌ی ساب‌اسکریپشن‌ها به‌روزرسانی شدند');
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی', 'error');
    } finally {
      setUpdatingSubs(false);
    }
  }, [updatingSubs, refresh, showToast]);

  const handleDeleteSubscription = useCallback(async (id) => {
    const updated = await window.soul.deleteSubscription(id);
    setProfiles(updated);
    await refresh();
  }, [refresh]);

  const handleUpdateSubscription = useCallback(async (id, patch) => {
    const updated = await window.soul.updateSubscription(id, patch);
    setSubscriptions(updated);
    showToast('ساب‌اسکریپشن به‌روزرسانی شد');
  }, [showToast]);

  const handleSetMode = useCallback(async (mode) => {
    if (mode === connectionMode || connectionState !== 'disconnected') return;
    try {
      await window.soul.setMode(mode);
      setConnectionMode(mode);
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت', 'error');
    }
  }, [connectionMode, connectionState, showToast]);

  async function handleUpdateSettings(patch) {
    try {
      const updated = await window.soul.updateSettings(patch);
      setSettings(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات', 'error');
    }
  }

  // Same as handleUpdateSettings but rethrows on failure so callers that need
  // to react locally (e.g. reverting an optimistic input) can await it.
  async function handleUpdateSettingsChecked(patch) {
    try {
      const updated = await window.soul.updateSettings(patch);
      setSettings(updated);
      return updated;
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات', 'error');
      throw err;
    }
  }

  async function handleExportBackup() {
    try {
      const res = await window.soul.exportBackup();
      if (!res.canceled) showToast('پشتیبان‌گیری با موفقیت انجام شد');
    } catch (err) {
      showToast(err.message || 'خطا در پشتیبان‌گیری', 'error');
    }
  }

  async function handleImportBackup() {
    try {
      const res = await window.soul.importBackup();
      if (!res.canceled) {
        await refresh();
        showToast(`${res.profiles} کانفیگ بازیابی شد`);
      }
    } catch (err) {
      showToast(err.message || 'خطا در بازیابی', 'error');
    }
  }

  async function handleResetUsage(id) {
    const updated = await window.soul.resetUsage(id);
    setProfiles(updated);
  }

  async function handleResetAllUsage() {
    const updated = await window.soul.resetAllUsage();
    setProfiles(updated);
  }

  // Never sets local state optimistically: main answers with what Windows
  // actually ended up in, and that is the only thing rendered. An optimistic
  // `true` here is precisely how the old UI came to claim a proxy that had
  // failed to apply.
  const handleSystemProxySetDesired = useCallback(async (desired) => {
    try {
      const status = await window.soul.systemProxySetDesired(desired);
      if (status) setSystemProxy(status);
      if (status?.note) showToast(status.note);
      else if (desired) showToast(status?.active ? 'پروکسی سیستم فعال شد' : 'ثبت شد');
      else showToast('پروکسی سیستم بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در تنظیم پروکسی سیستم', 'error');
      window.soul.systemProxyGet?.().then((s) => { if (s) setSystemProxy(s); }).catch(() => {});
    }
  }, [showToast]);

  const handleSystemProxySync = useCallback(async () => {
    try {
      const status = await window.soul.systemProxySync();
      if (status) setSystemProxy(status);
      showToast(status?.lastError ? status.lastError : 'وضعیت پروکسی سیستم بررسی شد', status?.lastError ? 'error' : 'info');
    } catch (err) {
      showToast(err.message || 'بررسی ناموفق بود', 'error');
    }
  }, [showToast]);

  const handleOpenProxyFolder = useCallback(() => window.soul.openProxyFolder(), []);

  const handleDismissUpdate = useCallback(() => {
    setUpdateDismissed(updaterStatus?.version || null);
  }, [updaterStatus?.version]);

  const handleDismissFailover = useCallback(() => setFailoverEvent(null), []);

  const handleEmergencyDisableKillSwitch = useCallback(async () => {
    try {
      const updated = await window.soul.updateSettings({ killSwitchEnabled: false });
      setSettings(updated);
      setKillSwitchBlocking(false);
      showToast('Kill Switch غیرفعال شد و اینترنت آزاد شد');
    } catch (err) {
      showToast(err.message || 'خطا در غیرفعال‌سازی Kill Switch', 'error');
    }
  }, [showToast]);

  const handleResetAllSettings = useCallback(async () => {
    try {
      const updated = await window.soul.resetAllSettings();
      setSettings(updated);
      showToast('همه‌ی تنظیمات به حالت پیش‌فرض برگشت');
    } catch (err) {
      showToast(err.message || 'بازنشانی ناموفق بود', 'error');
    }
  }, [showToast]);

  const handleResetNetworkDefaults = useCallback(async () => {
    try {
      const updated = await window.soul.resetNetworkDefaults();
      setSettings(updated);
      showToast('تنظیمات شبکه بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در بازنشانی تنظیمات شبکه', 'error');
    }
  }, [showToast]);

  // A pool server isn't in `profiles`, so fall back to the copy main ships
  // with the state payload -- otherwise the hero would claim no server is
  // selected while the tunnel is up on a pool server.
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId)
      || (activeSoulProfile && activeSoulProfile.id === activeProfileId ? activeSoulProfile : undefined),
    [profiles, activeProfileId, activeSoulProfile]
  );

  const heroPhase = useMemo(() => {
    if (connectionState !== 'disconnected') return connectionState;
    if (soulSweeping || busy) return 'preparing';
    return 'disconnected';
  }, [connectionState, soulSweeping, busy]);

  // What pressing connect would actually reach. Not always a profile: the Soul
  // pool and "choose the best for me" are real selections with no
  // `activeProfileId` behind them, and reading `activeProfile` alone is how the
  // hero came to claim no server was selected while the sidebar showed one.
  const heroTarget = useMemo(() => {
    if (activeProfile) {
      return {
        name: activeProfile.name || activeProfile.address,
        detail: `${activeProfile.address}:${activeProfile.port}`,
        mono: true,
      };
    }
    if (soulMode) {
      return {
        name: 'سرورهای سول کانکشن',
        detail: soulCount ? `${soulCount} سرور — انتخاب خودکار بهترین` : 'انتخاب خودکار بهترین',
      };
    }
    if (settings?.autoSelectBestServer && profiles.length > 0) {
      return { name: 'انتخاب خودکار بهترین سرور', detail: `از میان ${profiles.length} کانفیگ` };
    }
    return null;
  }, [activeProfile, soulMode, soulCount, settings?.autoSelectBestServer, profiles.length]);

  // The sidebar card appears for every state that has something to say about a
  // specific release, and only that. A dismissal silences the offer, but never
  // a download that is already running or an install waiting to happen -- those
  // are in flight and the user needs to be able to see and stop them.
  const updateOffered = (() => {
    const s = updaterStatus?.status;
    if (!s || !updaterStatus.version) return false;
    if (['downloading', 'verifying', 'installing'].includes(s)) return true;
    if (s === 'ready') return true;
    if (s === 'available' || s === 'error') return updateDismissed !== updaterStatus.version;
    return false;
  })();

  return (
    <div className={`app-shell ${windowMaximized ? 'maximized' : ''}`}>
      <TitleBar
        maximized={windowMaximized}
        onMinimize={() => window.soul.windowMinimize()}
        onToggleMaximize={() => window.soul.windowToggleMaximize()}
        onClose={() => window.soul.windowClose()}
      />
      <div className="workspace">
        <aside className="sidebar">
          <header className="sidebar-head">
            <img className="mark" src="./icon.png" alt="" />
            <div className="brand">
              <span className="brand-name">Soul Connection</span>
              <span className="brand-sub">
                {profiles.length ? `${profiles.length} کانفیگ` : 'کلاینت V2Ray / Xray'}
              </span>
            </div>
          </header>

          <SoulPoolEntry
            enabled={soulMode}
            count={soulCount}
            connectionState={connectionState}
            progress={soulProgress}
            activeSoulProfile={activeSoulProfile}
            busy={busy && !soulCancelable}
            refreshing={soulRefreshing}
            cancelable={soulCancelable}
            onSelect={handleSoulSelect}
            onRefresh={handleSoulRefresh}
          />

          <ServerList
            profiles={profiles}
            subscriptions={subscriptions}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            pings={pings}
            updatingSubs={updatingSubs}
            refreshingSubIds={refreshingSubIds}
            onSelect={handleSelect}
            onDelete={handleDelete}
            onPing={handlePing}
            onPingAll={handlePingAll}
            pingSweep={pingSweep}
            onCancelPingAll={handleCancelPingAll}
            onDismissPingSweep={handleDismissPingSweep}
            onAdd={() => setShowAdd(true)}
            onRefreshSubscription={handleRefreshSubscription}
            onUpdateAllSubscriptions={handleUpdateAllSubscriptions}
            onDeleteSubscription={handleDeleteSubscription}
            onConnectTo={handleConnectTo}
            onDisconnect={handleDisconnect}
            onRenameProfile={handleRenameProfile}
            onEditProfile={handleEditProfile}
            onUpdateSubscription={handleUpdateSubscription}
            onToast={showToast}
            initialQuery={sessionRef.current.query}
            initialSortBy={sessionRef.current.sortBy}
            initialCollapsed={sessionRef.current.collapsed}
            onSessionChange={handleSessionChange}
          />

          {updateOffered && (
            <UpdateCard
              update={updaterStatus}
              onDownload={downloadAndInstall}
              onInstall={installUpdate}
              onCancelDownload={cancelUpdateDownload}
              onCancelAuto={cancelAutoInstall}
              onDismiss={handleDismissUpdate}
            />
          )}

          {profiles.length > 0 && (
            <footer className="sidebar-foot">
              <button className="btn primary add-btn" onClick={() => setShowAdd(true)}>
                <Icon name="plus" size={15} />
                افزودن کانفیگ
              </button>
              <button
                className="icon-btn tall"
                onClick={() => setFinderOpen(true)}
                title="سرور یاب هوشمند (Ctrl+K)"
              >
                <Icon name="radar" size={15} />
              </button>
            </footer>
          )}
        </aside>

        <main className="main">
          <header className="main-head">
            <span className="main-title">
              {tab === 'settings' ? 'تنظیمات' : tab === 'routing' ? 'قوانین مسیریابی' : 'کنترل اتصال'}
            </span>
            <div className="main-head-actions">
              <button
                className={`icon-btn ghost ${tab === 'routing' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'routing' ? 'servers' : 'routing')}
                title={tab === 'routing' ? 'بازگشت به کنترل اتصال' : 'قوانین مسیریابی'}
              >
                <Icon name={tab === 'routing' ? 'close' : 'filter'} size={16} />
              </button>
              <button
                className={`icon-btn ghost ${tab === 'settings' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'settings' ? 'servers' : 'settings')}
                title={tab === 'settings' ? 'بازگشت به کنترل اتصال' : 'تنظیمات'}
              >
                <Icon name={tab === 'settings' ? 'close' : 'settings'} size={16} />
              </button>
            </div>
          </header>

          {tab === 'servers' ? (
            <>
              <ConnectHero
                phase={heroPhase}
                connectionMode={connectionMode}
                target={heroTarget}
                onToggle={handleToggleConnect}
                onSetMode={handleSetMode}
              />
              {/* Sits between the hero and the metrics rail: the hero is the
                  action, this is the proof it worked, the rail is the running
                  telemetry. It renders nothing at all while disconnected, so
                  the idle screen stays exactly as it was. */}
              <TunnelStatus
                connectionState={connectionState}
                activeProfile={activeProfile}
                systemProxy={systemProxy}
                onToast={showToast}
              />
            </>
          ) : tab === 'routing' ? (
            <div className="settings-pane">
              <RoutingRules
                routing={routing}
                connectionState={connectionState}
                connectionMode={connectionMode}
                needsReconnect={routingNeedsReconnect}
                onSetMode={handleSetRoutingMode}
                onSetLanDirect={handleSetLanDirect}
                onSaveRule={handleSaveRule}
                onDeleteRule={handleDeleteRule}
                onToggleRule={handleToggleRule}
                onAddDomains={handleAddDomains}
                onReconnect={handleReconnect}
              />
            </div>
          ) : (
            <div className="settings-pane">
              {settings && (
                <SettingsView
                  settings={settings}
                  connectionState={connectionState}
                  profiles={profiles}
                  appInfo={appInfo}
                  systemProxy={systemProxy}
                  updaterStatus={updaterStatus}
                  onCheckForUpdates={() => window.soul.checkForUpdates()}
                  onDownloadUpdate={() => window.soul.downloadUpdate()}
                  onDownloadAndInstall={() => window.soul.downloadAndInstall()}
                  onInstallUpdate={() => window.soul.installUpdate()}
                  onCancelUpdateDownload={() => window.soul.cancelUpdateDownload?.()}
                  onCancelAutoInstall={() => window.soul.cancelAutoInstall?.()}
                  onOpenUpdateFolder={() => window.soul.openUpdateFolder?.()}
                  shield={shield}
                  shieldProgress={shieldProgress}
                  onShieldTune={async () => {
                    try {
                      setShieldProgress({ running: true, phase: 'start' });
                      setShield(await window.soul.shieldTune());
                    } catch (err) {
                      showToast(err.message || 'سنجش انجام نشد', 'error');
                    } finally {
                      setShieldProgress(null);
                    }
                  }}
                  onShieldCancel={() => window.soul.shieldCancel?.()}
                  onShieldClear={async () => setShield(await window.soul.shieldClear())}
                  onShieldManualKey={async (k) => setShield(await window.soul.shieldSetManualKey(k))}
                  onUpdate={handleUpdateSettings}
                  onUpdateChecked={handleUpdateSettingsChecked}
                  onOpenLogsFolder={() => window.soul.openLogsFolder()}
                  onExportBackup={handleExportBackup}
                  onImportBackup={handleImportBackup}
                  onResetUsage={handleResetUsage}
                  onResetAllUsage={handleResetAllUsage}
                  onSystemProxySetDesired={handleSystemProxySetDesired}
                  onSystemProxySync={handleSystemProxySync}
                  onOpenProxyFolder={handleOpenProxyFolder}
                  onResetNetworkDefaults={handleResetNetworkDefaults}
                  onResetAllSettings={handleResetAllSettings}
                  killSwitchBlocking={killSwitchBlocking}
                  health={health}
                  failover={failover}
                />
              )}
            </div>
          )}

          {failoverEvent && (
            <FailoverStatus event={failoverEvent} onDismiss={handleDismissFailover} />
          )}

          {killSwitchBlocking && (
            <div className="killswitch-banner" role="alert">
              <Icon name="shield" size={16} />
              <span className="killswitch-banner-text">
                Kill Switch فعال است — تمام ترافیک اینترنت مسدود شده تا وقتی دوباره وصل شوی.
              </span>
              <button className="btn danger killswitch-banner-btn" onClick={handleEmergencyDisableKillSwitch}>
                غیرفعال‌سازی اضطراری
              </button>
            </div>
          )}

          <StatusBar
            connectionState={heroPhase}
            activeProfile={activeProfile}
            connectedAt={connectedAt}
            selectedPing={activeProfileId ? pingMs(pings[activeProfileId]) : undefined}
            killSwitchBlocking={killSwitchBlocking}
            notice={toast}
          />
        </main>
      </div>

      {finderOpen && (
        <ServerFinder
          profiles={profiles}
          subscriptions={subscriptions}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onClose={() => setFinderOpen(false)}
          onConnect={handleConnectTo}
          onToggleFavorite={handleToggleFavorite}
        />
      )}

      {showAdd && (
        <AddModal
          onClose={() => setShowAdd(false)}
          onAddLink={handleAddLink}
          onAddSubscription={handleAddSubscription}
          onAddCustom={handleAddCustom}
        />
      )}
    </div>
  );
}
