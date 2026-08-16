import { useCallback, useEffect, useRef, useState } from 'react';

// The one toast in the app. `showToast` is stable (useCallback with no deps)
// on purpose: it flows into React.memo'd children that sit in the hottest
// paths (ping-all, 1s traffic ticks) -- a fresh function reference every App
// render would defeat memoization and re-render the whole tree.
//
// The dismiss timer is tracked so a second toast restarts the countdown --
// otherwise the previous toast's timer fires mid-life and clears the new one
// early (very visible in flows that toast twice in a row, like add + connect).
export default function useToast() {
  const [toast, setToast] = useState(null);
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

  return { toast, showToast };
}
