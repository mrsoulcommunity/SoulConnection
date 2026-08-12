import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes, formatSpeed } from '../utils/format.js';
import { toneForMs } from '../utils/ping.js';

const SHORT_STATUS = {
  disconnected: 'قطع',
  preparing: 'در حال آماده‌سازی…',
  connecting: 'در حال اتصال…',
  connected: 'متصل',
  disconnecting: 'در حال قطع…',
};

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function StatusBar({
  connectionState, activeProfile, connectedAt, latencyMs, selectedPing, traffic, notice,
  killSwitchBlocking,
}) {
  const connected = connectionState === 'connected';
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!connected || !connectedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connected, connectedAt]);

  const duration = connected && connectedAt ? formatDuration(now - connectedAt) : null;

  // Live tunnel latency once connected; the last manual ping of the
  // selected server otherwise, so the rail is never empty for no reason.
  const ping = connected
    ? latencyMs
    : (typeof selectedPing === 'number' && selectedPing > 0 ? selectedPing : null);
  const pingText = connected && latencyMs == null
    ? '…'
    : ping == null ? '—' : ping < 0 ? 'بدون پاسخ' : `${ping}ms`;

  // Kill Switch outranks the connection state in this segment: "قطع" is true
  // but badly incomplete when the reason nothing works is that we are blocking
  // every packet on purpose. The dot style for it already existed in the
  // stylesheet -- until now nothing on this screen ever applied it.
  const blocking = !!killSwitchBlocking && !connected;

  return (
    <footer className="status-rail">
      <div className="rail-seg">
        <span className="rail-label">وضعیت</span>
        <span className="rail-value">
          <span className={`status-dot ${blocking ? 'blocking' : connectionState}`} />
          {blocking ? 'مسدود' : SHORT_STATUS[connectionState]}
        </span>
      </div>

      <div className="rail-seg grow">
        <span className="rail-label">سرور</span>
        <span className="rail-value" title={activeProfile ? `${activeProfile.address}:${activeProfile.port}` : undefined}>
          {activeProfile ? (activeProfile.name || activeProfile.address) : '—'}
        </span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">پینگ</span>
        <span className={`rail-value mono tone-${toneForMs(ping)}`}>{pingText}</span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">سرعت</span>
        <span className="rail-value mono">
          {connected && traffic ? (
            <>
              <span className="speed-down">
                <Icon name="arrowDown" size={11} />
                {formatSpeed(traffic.downlinkSpeed)}
              </span>
              <span className="speed-up">
                <Icon name="arrowUp" size={11} />
                {formatSpeed(traffic.uplinkSpeed)}
              </span>
            </>
          ) : '—'}
        </span>
      </div>

      <div className="rail-seg optional">
        <span className="rail-label">مصرف نشست</span>
        <span className="rail-value mono">
          {connected && traffic ? formatBytes(traffic.sessionTotal) : '—'}
        </span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">مدت اتصال</span>
        <span className="rail-value mono">{duration ?? '—'}</span>
      </div>

      {/* Always mounted, for two reasons. An aria-live region has to exist in
          the DOM *before* its content changes or assistive tech has nothing to
          watch and the announcement is simply dropped. And the notice now
          floats above the rail instead of covering it: a message that lasts
          2.6s must not take the duration, speed and ping readouts away --
          least of all at the moment of connect, which is exactly when it
          fires and exactly when those numbers matter most. */}
      <div
        className={`rail-notice ${notice ? 'visible' : ''} ${notice?.type === 'error' ? 'error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {notice && (
          <>
            <Icon name={notice.type === 'error' ? 'info' : 'check'} size={14} />
            <span className="rail-notice-text">{notice.msg}</span>
          </>
        )}
      </div>
    </footer>
  );
}

// `selectedPing`/`activeProfile` are usually unchanged on any given ping-all
// tick (only the pinged profile's value moves), so memoizing skips a re-render
// of this whole footer for every other tick.
export default React.memo(StatusBar);
