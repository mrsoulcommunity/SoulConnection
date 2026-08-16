import { useCallback, useMemo, useState } from 'react';

// Every action that starts or stops a tunnel, and the one `busy` flag they
// all share. Connect, disconnect, the hero toggle, picking a server, picking
// the Soul pool, switching proxy/TUN -- these cannot live in separate hooks
// because they guard each other: a connect in flight must make every other
// entry point refuse, and that is only reliable when they read the same flag.
export default function useConnection(main, showToast) {
  const {
    connectionState, activeProfileId, soulMode, soulProgress, settings, profiles, set,
  } = main;
  const [busy, setBusy] = useState(false);
  const [soulRefreshing, setSoulRefreshing] = useState(false);

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

  const heroPhase = useMemo(() => {
    if (connectionState !== 'disconnected') return connectionState;
    if (soulSweeping || busy) return 'preparing';
    return 'disconnected';
  }, [connectionState, soulSweeping, busy]);

  const handleToggleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (connectionState === 'connected' || connectionState === 'connecting') {
        await window.soul.disconnect();
      } else if (soulMode) {
        // The pool picks the server; this is the whole point of the mode.
        set.setSoulProgress({ phase: 'fetching' });
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
  }, [busy, connectionState, activeProfileId, soulMode, settings, profiles.length, set, showToast]);

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

  const handleSelect = useCallback(async (id) => {
    // Picking a server by hand leaves pool mode. Main does the same on its
    // side when connecting, but this keeps the sidebar honest while idle.
    if (soulMode) {
      set.setSoulMode(false);
      set.setSoulProgress(null);
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
      set.setActiveProfileId(id);
    }
  }, [connectionState, soulMode, set, showToast]);

  const handleSetMode = useCallback(async (mode) => {
    if (mode === main.connectionMode || connectionState !== 'disconnected') return;
    try {
      await window.soul.setMode(mode);
      set.setConnectionMode(mode);
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت', 'error');
    }
  }, [main.connectionMode, connectionState, set, showToast]);

  // Rebuild the tunnel on the same profile -- how a pending routing change
  // actually reaches xray.
  const handleReconnect = useCallback(async () => {
    if (busy || !activeProfileId) return;
    setBusy(true);
    try {
      await window.soul.connect(activeProfileId);
      set.setRoutingNeedsReconnect(false);
    } catch (err) {
      showToast(err.message || 'خطا در اتصال مجدد', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, activeProfileId, set, showToast]);

  // Selecting the pool row. Toggling it off falls back to manual selection;
  // doing either mid-sweep cancels the sweep rather than queueing behind it.
  const handleSoulSelect = useCallback(async () => {
    try {
      if (soulCancelable) {
        await window.soul.soulCancel();
        set.setSoulProgress(null);
        return;
      }
      const next = !soulMode;
      await window.soul.soulSetEnabled(next);
      set.setSoulMode(next);
      if (!next) set.setSoulProgress(null);
    } catch (err) {
      showToast(err.message || 'خطا', 'error');
    }
  }, [soulMode, soulCancelable, set, showToast]);

  const handleSoulRefresh = useCallback(async () => {
    setSoulRefreshing(true);
    try {
      const r = await window.soul.soulList(true);
      set.setSoulCount(r.count);
      showToast(`${r.count} سرور سول کانکشن به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در دریافت فهرست', 'error');
    } finally {
      setSoulRefreshing(false);
    }
  }, [set, showToast]);

  return {
    busy,
    soulSweeping,
    soulCancelable,
    soulRefreshing,
    heroPhase,
    handleToggleConnect,
    handleConnectTo,
    handleDisconnect,
    handleSelect,
    handleSetMode,
    handleReconnect,
    handleSoulSelect,
    handleSoulRefresh,
  };
}
