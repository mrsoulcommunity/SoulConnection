import { useCallback, useEffect, useState } from 'react';

// The frameless window's chrome state: whether it is maximized (drives the
// restore/maximize glyph and the .maximized class that squares the corners)
// plus the three titlebar actions.
export default function useWindowChrome() {
  const [windowMaximized, setWindowMaximized] = useState(false);

  useEffect(() => {
    window.soul.windowIsMaximized?.().then(setWindowMaximized).catch(() => {});
    const off = window.soul.onWindowState?.(({ maximized }) => setWindowMaximized(maximized));
    return () => off && off();
  }, []);

  const minimize = useCallback(() => window.soul.windowMinimize(), []);
  const toggleMaximize = useCallback(() => window.soul.windowToggleMaximize(), []);
  const close = useCallback(() => window.soul.windowClose(), []);

  return { windowMaximized, minimize, toggleMaximize, close };
}
