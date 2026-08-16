import { useCallback } from 'react';

// ---- Smart Routing ----
//
// Every mutation answers with the whole routing state, so the UI never has to
// guess what the main process did with the rule it just sent (normalization
// rewrites exe paths and domain forms) -- it just renders what came back.
export default function useRoutingActions(main, showToast) {
  const { set } = main;

  const applyRouting = useCallback((state) => {
    if (!state) return;
    set.setRouting(state);
    if (state.needsReconnect) set.setRoutingNeedsReconnect(true);
  }, [set]);

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

  return {
    handleSetRoutingMode,
    handleSetLanDirect,
    handleSaveRule,
    handleDeleteRule,
    handleToggleRule,
    handleAddDomains,
  };
}
