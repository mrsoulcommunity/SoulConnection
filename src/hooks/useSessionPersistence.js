import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSession, saveSession, clearSession } from '../utils/sessionState.js';

// "Restore Previous Session": the active tab plus whatever ServerList reports
// (query/sortBy/collapsed), persisted to localStorage while the setting is on.
//
// Seeded eagerly (before `settings` loads) from whatever was last saved --
// if the setting turns out to be off, the effect below wipes the stored
// session so the NEXT launch starts clean. A one-time restore before that
// check resolves is a harmless, self-correcting edge case, not worth delaying
// the sidebar's first render to avoid.
export default function useSessionPersistence(settings) {
  const sessionRef = useRef(null);
  if (sessionRef.current === null) sessionRef.current = loadSession() || {};
  const [tab, setTab] = useState(() => sessionRef.current.tab || 'servers');

  // Persist the active tab whenever it changes, but only while the setting is
  // on -- and wipe any stored session the moment it's turned off, so a
  // disabled toggle actually stays disabled.
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

  return { tab, setTab, sessionRef, handleSessionChange };
}
