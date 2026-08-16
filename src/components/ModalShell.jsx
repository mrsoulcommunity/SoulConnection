import React, { useCallback, useEffect, useRef } from 'react';

// ---- The modal shell ----
//
// Every dialog in the app was a bare `.overlay` div with exactly one behaviour:
// clicking the backdrop closed it. Four things were missing, and they were
// missing identically in all eight of them, because each was written by hand:
//
//   Escape        the first key anyone tries. Only the Server Finder listened
//                 for it, so every other dialog could be dismissed with the
//                 mouse alone -- in an app whose main flows are keyboard-driven
//                 (Ctrl+K, Ctrl+V, Enter to save).
//   focus trap    Tab walked straight out of the dialog into the sidebar behind
//                 it, where Enter connects to a server. That is reachable while
//                 a "delete this config permanently?" confirmation is still up.
//   focus return  closing dropped focus onto <body>, so the next Tab restarted
//                 from the top of the window instead of the control the dialog
//                 was opened from.
//   semantics     no role, no aria-modal, no accessible name: a screen reader
//                 announced an anonymous group and went on offering the whole
//                 page underneath as though it were still reachable.
//
// It also owns `document.body.dataset.modalOpen`, which App.jsx's global
// shortcut guard reads before firing. That flag used to be set by ServerList
// alone, so Ctrl+K could open the Server Finder on top of a routing-rule
// dialog, and Ctrl+V could add a config behind a QR sheet. Counted rather than
// assigned a boolean, because dialogs do stack (a confirmation raised from a
// details sheet) and the inner one closing must not clear the flag while the
// outer one is still on screen.

let openCount = 0;

function markOpen() {
  openCount += 1;
  document.body.dataset.modalOpen = 'true';
}

function markClosed() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) document.body.dataset.modalOpen = 'false';
}

// For the overlays that are NOT a `.overlay` dialog but still own the screen --
// the context menu, the batch-test sheet. They need the same flag for the same
// reason, and they must go through the same counter or their cleanup would
// clear it out from under a dialog that is still open.
export function useModalOpenFlag(active) {
  useEffect(() => {
    if (!active) return undefined;
    markOpen();
    return markClosed;
  }, [active]);
}

// Everything Tab can land on, minus what it deliberately skips: disabled
// controls, and anything parked at `tabindex="-1"` (which includes the dialog
// box itself, so the trap never counts its own container as a stop).
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function ModalShell({ label, onClose, className = '', children }) {
  const boxRef = useRef(null);
  // Captured during the first render, NOT in the effect below. React applies a
  // child's `autoFocus` while committing the DOM, which is before any effect
  // runs -- so by the time an effect could read `document.activeElement` it is
  // already the dialog's own first field, and "restore focus" would restore it
  // to a node that is about to be unmounted. Reading it here catches the real
  // opener, because nothing has been committed yet.
  const restoreRef = useRef(undefined);
  if (restoreRef.current === undefined) restoreRef.current = document.activeElement;
  // Whether the press that is about to become a click STARTED on the backdrop.
  // Without this, selecting text in a textarea and releasing the mouse past the
  // dialog's edge counted as a backdrop click and threw the edit away.
  const backdropPressRef = useRef(false);

  useEffect(() => {
    markOpen();
    return () => {
      markClosed();
      // Hand focus back to whatever opened the dialog -- but only if it still
      // exists. A rename dialog routinely outlives the row it was opened from,
      // and focusing a detached node quietly focuses <body> instead.
      const el = restoreRef.current;
      if (el && el.isConnected && typeof el.focus === 'function') el.focus();
    };
  }, []);

  // Most dialogs autoFocus their first field. This covers the ones with no
  // field to focus -- a confirmation, the QR sheet -- so the trap below always
  // has a starting point inside the dialog and Escape always has a listener.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || box.contains(document.activeElement)) return;
    (box.querySelector(FOCUSABLE) || box).focus();
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      // Stopped here so a stacked dialog closes one layer per press. Focus is
      // always inside the topmost shell, so it is the one that sees the key.
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const box = boxRef.current;
    if (!box) return;
    // `offsetParent === null` catches anything hidden by an ancestor, which is
    // how a dialog with a collapsed section would otherwise trap Tab on a
    // control nobody can see.
    const items = [...box.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropPressRef.current) onClose();
        backdropPressRef.current = false;
      }}
    >
      <div
        ref={boxRef}
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
