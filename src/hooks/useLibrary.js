import { useCallback, useState } from 'react';

// The config library: everything that adds, edits or removes profiles and
// subscriptions, plus the add-config modal's open state (the add flow is the
// modal, so they travel together). Mutation answers from main are written
// back through `main.set`; anything main pushes on its own (a tray import, a
// scheduled subscription refresh) arrives via useMainState's
// `onProfilesChanged` and needs nothing from here.
export default function useLibrary(main, showToast) {
  const { refresh, set } = main;
  const [showAdd, setShowAdd] = useState(false);
  const [updatingSubs, setUpdatingSubs] = useState(false);
  const [refreshingSubIds, setRefreshingSubIds] = useState(() => new Set());

  const openAdd = useCallback(() => setShowAdd(true), []);
  const closeAdd = useCallback(() => setShowAdd(false), []);

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

  const handleDelete = useCallback(async (id) => {
    const updated = await window.soul.deleteProfile(id);
    set.setProfiles(updated);
    set.setActiveProfileId((cur) => (cur === id ? null : cur));
  }, [set]);

  const handleRenameProfile = useCallback(async (id, name) => {
    const updated = await window.soul.renameProfile(id, name);
    set.setProfiles(updated);
  }, [set]);

  const handleEditProfile = useCallback(async (id, link) => {
    const updated = await window.soul.updateProfile(id, link);
    set.setProfiles(updated);
    showToast('کانفیگ به‌روزرسانی شد');
  }, [set, showToast]);

  const handleToggleFavorite = useCallback(async (profile) => {
    try {
      const updated = await window.soul.setFavorite(profile.id, !profile.favorite);
      set.setProfiles(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره', 'error');
    }
  }, [set, showToast]);

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
    set.setProfiles(updated);
    await refresh();
  }, [set, refresh]);

  const handleUpdateSubscription = useCallback(async (id, patch) => {
    const updated = await window.soul.updateSubscription(id, patch);
    set.setSubscriptions(updated);
    showToast('ساب‌اسکریپشن به‌روزرسانی شد');
  }, [set, showToast]);

  return {
    showAdd,
    openAdd,
    closeAdd,
    updatingSubs,
    refreshingSubIds,
    handleAddLink,
    handleAddSubscription,
    handleAddCustom,
    handleDelete,
    handleRenameProfile,
    handleEditProfile,
    handleToggleFavorite,
    handleRefreshSubscription,
    handleUpdateAllSubscriptions,
    handleDeleteSubscription,
    handleUpdateSubscription,
  };
}
