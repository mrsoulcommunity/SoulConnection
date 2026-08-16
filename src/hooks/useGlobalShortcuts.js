import { useCallback, useEffect } from 'react';

// The app-wide keyboard shortcuts: Ctrl+K / Ctrl+F opens the Server Finder,
// Ctrl+V smart-adds whatever the clipboard holds.
//
// Every global shortcut has to answer the same question before it fires: is
// the user typing into something, or does a modal already own the screen?
// That rule was written out for Ctrl+V and not at all for Ctrl+K, which is
// why Ctrl+F inside the sidebar's own search box opened the finder, and why
// Ctrl+K could open the finder *behind* a modal that was already up.
//
// `modalOpen` is raised by ModalShell for every dialog in the app (and by
// useModalOpenFlag for the overlays that aren't dialogs), so the one flag
// answers for all of them.
export default function useGlobalShortcuts({
  finderOpen,
  setFinderOpen,
  onAddLink,
  onAddSubscription,
  showToast,
}) {
  const shortcutBlocked = useCallback((e) => {
    const t = e.target;
    if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return true;
    return document.body.dataset.modalOpen === 'true';
  }, []);

  // Ctrl+K (or Ctrl+F) opens the server finder from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'k' && k !== 'f') return;
      // Closing is always allowed: the finder's own search box is an input, so
      // the guard would otherwise trap the user inside the thing they opened.
      if (!finderOpen && shortcutBlocked(e)) return;
      e.preventDefault();
      setFinderOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finderOpen, setFinderOpen, shortcutBlocked]);

  // Global Ctrl+V: smart-detect clipboard content (config link vs subscription
  // URL) and add it, unless the user is pasting into a real field/modal.
  useEffect(() => {
    const onKey = async (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
      if (finderOpen || shortcutBlocked(e)) return;

      e.preventDefault();
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showToast('دسترسی به کلیپ‌بورد ممکن نشد', 'error');
        return;
      }
      text = (text || '').trim();
      if (!text) return;

      try {
        // Look for a config prefix ANYWHERE in the paste, not just at the
        // very start -- a multi-config paste can have a leading blank line,
        // a label, or other text before the first real link.
        if (/(vmess|vless|trojan|ss):\/\//i.test(text)) {
          await onAddLink(text);
        } else if (/^https?:\/\//i.test(text)) {
          await onAddSubscription(text);
        } else {
          showToast('محتوای کلیپ‌بورد یک کانفیگ یا لینک سابسکریپشن معتبر نیست', 'error');
        }
      } catch (err) {
        showToast(err.message || 'خطا در افزودن از کلیپ‌بورد', 'error');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finderOpen, shortcutBlocked, onAddLink, onAddSubscription, showToast]);
}
