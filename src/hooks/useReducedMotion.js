import { useEffect } from 'react';

// ---- The motion preference ----
//
// Two independent triggers -- Windows' own "show animations" setting and the
// app's own toggle -- and one outcome, so the OR is computed here and put on
// <html> as a class. CSS cannot set a class from a media query, and the
// alternative (a `prefers-reduced-motion` block plus a duplicate class block)
// means keeping forty rules in sync by hand. Applied to the document root
// rather than threaded through props because the rules that read it are
// spread across every screen in the app.
export default function useReducedMotion(reduceMotionSetting) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      document.documentElement.classList.toggle(
        'reduce-motion',
        reduceMotionSetting === true || mq.matches
      );
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [reduceMotionSetting]);
}
