import { useCallback } from 'react';

// Adaptive Shield actions. The tune seeds `shieldProgress` optimistically so
// the panel reacts to the click at once; the real sweep readout then arrives
// on the push channel (useMainState), and the settled state is re-read when
// the sweep resolves rather than derived from events.
export default function useShieldActions(main, showToast) {
  const { set } = main;

  const handleShieldTune = useCallback(async () => {
    try {
      set.setShieldProgress({ running: true, phase: 'start' });
      set.setShield(await window.soul.shieldTune());
    } catch (err) {
      showToast(err.message || 'سنجش انجام نشد', 'error');
    } finally {
      set.setShieldProgress(null);
    }
  }, [set, showToast]);

  const handleShieldCancel = useCallback(() => window.soul.shieldCancel?.(), []);

  const handleShieldClear = useCallback(async () => {
    set.setShield(await window.soul.shieldClear());
  }, [set]);

  const handleShieldManualKey = useCallback(async (key) => {
    set.setShield(await window.soul.shieldSetManualKey(key));
  }, [set]);

  return { handleShieldTune, handleShieldCancel, handleShieldClear, handleShieldManualKey };
}
