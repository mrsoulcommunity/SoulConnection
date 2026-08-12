import React from 'react';
import Icon from './Icon.jsx';

// The hero knows exactly two things: which `phase` the connection is in, and
// what it would be connecting to (`target`).
//
// It used to read `connectionState` straight from main, which is only part of
// the truth. The renderer can be genuinely busy -- an IPC call in flight, a
// Soul pool sweep running -- while main still reports 'disconnected'. The hero
// then painted an enabled "اتصال" button whose handler returned immediately,
// so the button looked alive and silently did nothing. `phase` folds those
// in-flight states into 'preparing', which is why there is now one vocabulary
// here and nothing left for the hero and the sidebar to disagree about.
const STATUS_TEXT = {
  disconnected: 'متصل نیستی',
  preparing: 'در حال آماده‌سازی اتصال…',
  connecting: 'در حال برقراری تونل…',
  connected: 'اتصال برقرار است',
  disconnecting: 'در حال قطع اتصال…',
};

const LABELS = {
  disconnected: 'اتصال',
  preparing: 'در حال آماده‌سازی…',
  connecting: 'در حال اتصال…',
  connected: 'قطع اتصال',
  disconnecting: 'در حال قطع…',
};

function ConnectHero({ phase, connectionMode, target, onToggle, onSetMode }) {
  // Anything that isn't a settled state is a state the button can't act on.
  const busy = phase !== 'disconnected' && phase !== 'connected';
  const modeLocked = phase !== 'disconnected';

  return (
    <section className={`stage ${phase}`}>
      <div className="aurora aurora-idle" aria-hidden="true" />
      <div className="aurora aurora-live" aria-hidden="true" />

      <div className={`ring-wrap ${phase}`}>
        <div className="ring-halo" aria-hidden="true" />
        <svg className="ring-svg" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="ring-track" cx="100" cy="100" r="88" />
          <circle className="ring-spin" cx="100" cy="100" r="88" />
          <circle className="ring-arc" cx="100" cy="100" r="88" />
        </svg>
        <button className="connect-btn" onClick={onToggle} disabled={busy} aria-busy={busy || undefined}>
          <Icon name="power" size={32} strokeWidth={2.2} />
          <span className="label">{LABELS[phase]}</span>
        </button>
      </div>

      {/* A live region: connecting and disconnecting are the two things on this
          screen a screen-reader user most needs told, and they happen without
          any focus change to announce them. */}
      <div className="stage-status" role="status" aria-live="polite">
        <span className={`status-dot ${phase}`} />
        {STATUS_TEXT[phase]}
      </div>

      {/* `target` is what pressing the button would actually connect to, which
          is not always a profile: the Soul pool and "pick the best for me" are
          both real selections with no `activeProfile` behind them. Deriving
          this from `activeProfile` alone is how the hero came to say "no server
          selected" while the sidebar showed one selected. */}
      <div className="stage-server">
        {target ? (
          <>
            <span className="name">{target.name}</span>
            {target.detail && (
              <span className={`addr ${target.mono ? 'mono' : ''}`}>{target.detail}</span>
            )}
          </>
        ) : (
          'سروری انتخاب نشده — از فهرست کناری یکی را انتخاب کن'
        )}
      </div>

      <div className={`mode-switch ${connectionMode === 'tun' ? 'tun' : ''}`}>
        <span className="mode-thumb" aria-hidden="true" />
        <button
          className={`mode-pill ${connectionMode === 'proxy' ? 'active' : ''}`}
          disabled={modeLocked}
          onClick={() => onSetMode('proxy')}
        >
          پروکسی سیستم
        </button>
        <button
          className={`mode-pill ${connectionMode === 'tun' ? 'active' : ''}`}
          disabled={modeLocked}
          onClick={() => onSetMode('tun')}
        >
          تانل کامل
        </button>
      </div>
      <div className="mode-hint">
        {modeLocked ? 'برای تغییر حالت، اول اتصال را قطع کن' : ''}
      </div>
    </section>
  );
}

// Doesn't depend on `pings`/`traffic` -- memoized so App's 1s traffic-poll
// re-render and ping-all bursts don't repaint this whole animated hero.
export default React.memo(ConnectHero);
