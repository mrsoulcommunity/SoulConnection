import { useCallback } from 'react';

// System-proxy intent and verification. Never sets local state
// optimistically: main answers with what Windows actually ended up in, and
// that is the only thing rendered. An optimistic `true` here is precisely how
// the old UI came to claim a proxy that had failed to apply.
export default function useSystemProxyActions(main, showToast) {
  const { set } = main;

  const handleSystemProxySetDesired = useCallback(async (desired) => {
    try {
      const status = await window.soul.systemProxySetDesired(desired);
      if (status) set.setSystemProxy(status);
      if (status?.note) showToast(status.note);
      else if (desired) showToast(status?.active ? 'پروکسی سیستم فعال شد' : 'ثبت شد');
      else showToast('پروکسی سیستم بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در تنظیم پروکسی سیستم', 'error');
      window.soul.systemProxyGet?.().then((s) => { if (s) set.setSystemProxy(s); }).catch(() => {});
    }
  }, [set, showToast]);

  const handleSystemProxySync = useCallback(async () => {
    try {
      const status = await window.soul.systemProxySync();
      if (status) set.setSystemProxy(status);
      showToast(status?.lastError ? status.lastError : 'وضعیت پروکسی سیستم بررسی شد', status?.lastError ? 'error' : 'info');
    } catch (err) {
      showToast(err.message || 'بررسی ناموفق بود', 'error');
    }
  }, [set, showToast]);

  const handleOpenProxyFolder = useCallback(() => window.soul.openProxyFolder(), []);

  return { handleSystemProxySetDesired, handleSystemProxySync, handleOpenProxyFolder };
}
