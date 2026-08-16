import { useCallback, useMemo, useState } from 'react';

// Hoisted to module scope so they are the same function on every render.
// They close over nothing, and passing fresh arrows instead would defeat the
// React.memo on the cards that receive them.
export const downloadAndInstall = () => window.soul.downloadAndInstall();
export const installUpdate = () => window.soul.installUpdate();
export const cancelUpdateDownload = () => window.soul.cancelUpdateDownload?.();
export const cancelAutoInstall = () => window.soul.cancelAutoInstall?.();

// Whether the sidebar's update card is on screen, and the dismissal that
// hides it. The card appears for every state that has something to say about
// a specific release, and only that. A dismissal silences the offer, but
// never a download that is already running or an install waiting to happen --
// those are in flight and the user needs to be able to see and stop them.
export default function useUpdateOffer(updaterStatus) {
  // The version the card was dismissed for. Kept per-version so a later
  // release re-opens the card instead of inheriting an old "not now".
  const [updateDismissed, setUpdateDismissed] = useState(null);

  const updateOffered = useMemo(() => {
    const s = updaterStatus?.status;
    if (!s || !updaterStatus.version) return false;
    if (['downloading', 'verifying', 'installing'].includes(s)) return true;
    if (s === 'ready') return true;
    if (s === 'available' || s === 'error') return updateDismissed !== updaterStatus.version;
    return false;
  }, [updaterStatus, updateDismissed]);

  const handleDismissUpdate = useCallback(() => {
    setUpdateDismissed(updaterStatus?.version || null);
  }, [updaterStatus?.version]);

  return { updateOffered, handleDismissUpdate };
}
