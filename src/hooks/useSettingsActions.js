import { useCallback } from 'react';

// Actions of the settings screen: the settings patch calls plus the
// maintenance chores that live there (backup, usage counters, resets, the
// kill-switch escape hatch). Everything writes back exactly what main
// answered -- never an optimistic local guess.
export default function useSettingsActions(main, showToast) {
  const { refresh, set } = main;

  const handleUpdateSettings = useCallback(async (patch) => {
    try {
      const updated = await window.soul.updateSettings(patch);
      set.setSettings(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات', 'error');
    }
  }, [set, showToast]);

  // Same as handleUpdateSettings but rethrows on failure so callers that need
  // to react locally (e.g. reverting an optimistic input) can await it.
  const handleUpdateSettingsChecked = useCallback(async (patch) => {
    try {
      const updated = await window.soul.updateSettings(patch);
      set.setSettings(updated);
      return updated;
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات', 'error');
      throw err;
    }
  }, [set, showToast]);

  const handleExportBackup = useCallback(async () => {
    try {
      const res = await window.soul.exportBackup();
      if (!res.canceled) showToast('پشتیبان‌گیری با موفقیت انجام شد');
    } catch (err) {
      showToast(err.message || 'خطا در پشتیبان‌گیری', 'error');
    }
  }, [showToast]);

  const handleImportBackup = useCallback(async () => {
    try {
      const res = await window.soul.importBackup();
      if (!res.canceled) {
        await refresh();
        showToast(`${res.profiles} کانفیگ بازیابی شد`);
      }
    } catch (err) {
      showToast(err.message || 'خطا در بازیابی', 'error');
    }
  }, [refresh, showToast]);

  const handleResetUsage = useCallback(async (id) => {
    const updated = await window.soul.resetUsage(id);
    set.setProfiles(updated);
  }, [set]);

  const handleResetAllUsage = useCallback(async () => {
    const updated = await window.soul.resetAllUsage();
    set.setProfiles(updated);
  }, [set]);

  const handleEmergencyDisableKillSwitch = useCallback(async () => {
    try {
      const updated = await window.soul.updateSettings({ killSwitchEnabled: false });
      set.setSettings(updated);
      set.setKillSwitchBlocking(false);
      showToast('Kill Switch غیرفعال شد و اینترنت آزاد شد');
    } catch (err) {
      showToast(err.message || 'خطا در غیرفعال‌سازی Kill Switch', 'error');
    }
  }, [set, showToast]);

  const handleResetAllSettings = useCallback(async () => {
    try {
      const updated = await window.soul.resetAllSettings();
      set.setSettings(updated);
      showToast('همه‌ی تنظیمات به حالت پیش‌فرض برگشت');
    } catch (err) {
      showToast(err.message || 'بازنشانی ناموفق بود', 'error');
    }
  }, [set, showToast]);

  const handleResetNetworkDefaults = useCallback(async () => {
    try {
      const updated = await window.soul.resetNetworkDefaults();
      set.setSettings(updated);
      showToast('تنظیمات شبکه بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در بازنشانی تنظیمات شبکه', 'error');
    }
  }, [set, showToast]);

  return {
    handleUpdateSettings,
    handleUpdateSettingsChecked,
    handleExportBackup,
    handleImportBackup,
    handleResetUsage,
    handleResetAllUsage,
    handleEmergencyDisableKillSwitch,
    handleResetAllSettings,
    handleResetNetworkDefaults,
  };
}
