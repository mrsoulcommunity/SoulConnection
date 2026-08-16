import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import ContextMenu from './ContextMenu.jsx';
import { RenameModal, EditProfileModal, EditSubscriptionModal, SubscriptionDetailsModal, ConfirmModal } from './ManageModals.jsx';
import QrModal from './QrModal.jsx';
import SubTestModal from './SubTestModal.jsx';
import { useModalOpenFlag } from './ModalShell.jsx';
import * as engine from '../finder/testEngine.js';
import { formatBytes, relativeTime, subUsageInfo } from '../utils/format.js';
import { isMeasuring, pingMs, pingTone, pingTitle, toneForMs } from '../utils/ping.js';

function groupStats(items) {
  return { totalBytes: items.reduce((sum, p) => sum + (p.totalBytes || 0), 0) };
}

// The group's best measurement, isolated in its own memoized component.
//
// It used to be computed inside the grouping memo, which made `pings` a
// dependency of the entire group structure: every single measurement that
// landed rebuilt every group in the sidebar, and a sweep over a few hundred
// servers did that a few hundred times. Grouping now depends only on the
// profiles, and the one thing that genuinely moves with a measurement -- this
// pill -- is the only thing that re-renders.
const GroupPing = React.memo(function GroupPing({ items, pings }) {
  let best;
  for (const p of items) {
    const ms = pingMs(pings[p.id]);
    if (ms != null && ms >= 0 && (best === undefined || ms < best)) best = ms;
  }
  return (
    <span
      className={`stat-chip ping ${toneForMs(best ?? null)}`}
      title={best !== undefined ? 'بهترین پینگ اندازه‌گیری‌شده در این گروه' : 'هنوز پینگی گرفته نشده'}
    >
      {best !== undefined ? `${best}ms` : '—'}
    </span>
  );
});

// The measured value, or the reason there isn't one. Deliberately terse: this
// pill sits in a 296px sidebar next to a name that needs the room, and the full
// breakdown (median / min / max / jitter / loss / method) lives in the tooltip.
function PingPill({ entry, onClick }) {
  const measuring = isMeasuring(entry);
  const ms = pingMs(entry);
  const failed = !!entry && entry.status === 'fail';

  return (
    <button
      className={`ping ${pingTone(entry)} ${measuring ? 'measuring' : ''} ${entry?.method === 'tunnel' ? 'via-tunnel' : ''}`}
      onClick={onClick}
      title={pingTitle(entry)}
      aria-busy={measuring || undefined}
    >
      {measuring && <span className="ping-dots" aria-hidden="true"><i /><i /><i /></span>}
      {ms != null ? (
        // Keyed on the measurement time so a fresh reading remounts and
        // replays its entrance -- the row visibly confirms it just updated.
        <span key={entry.at || 'v'} className="ping-num">
          {ms}
          <span className="ping-unit">ms</span>
        </span>
      ) : !measuring && (
        <span className="ping-num">{failed ? '؟' : '—'}</span>
      )}
    </button>
  );
}

// A real ping takes several samples per server, so a sweep over a long list is
// measurably long. The toolbar button becomes the progress readout for it --
// and, while it runs, the way to stop it: a measurement you cannot call off is
// one you have to sit and wait out.
function SweepRing({ done, total, stopping }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const progress = total ? Math.min(done / total, 1) : 0;
  return (
    <span className={`sweep-ring ${stopping ? 'stopping' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 18 18" width="18" height="18">
        <circle className="sweep-ring-track" cx="9" cy="9" r={radius} />
        <circle
          className="sweep-ring-bar"
          cx="9"
          cy="9"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <span className="sweep-ring-glyph" />
    </span>
  );
}

// What a batch is doing, and then how it turned out. The result half is the
// part that did not exist before: after measuring fifty servers the answer was
// spread across fifty rows and nowhere else, so "did that help?" meant
// scrolling the whole list to find out.
function SweepStrip({ sweep, onDismiss }) {
  if (!sweep) return null;
  const percent = sweep.total ? Math.round((sweep.done / sweep.total) * 100) : 0;
  const failed = Math.max(0, sweep.done - sweep.ok);

  return (
    <div className={`ping-sweep ${sweep.running ? 'running' : 'settled'}`}>
      <div className="ping-sweep-track">
        <span className="ping-sweep-fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <div className="ping-sweep-row">
        {sweep.running ? (
          <>
            <span className="ping-sweep-count mono" dir="ltr">{sweep.done}/{sweep.total}</span>
            <span className="ping-sweep-label">
              {sweep.cancelled ? 'در حال توقف…' : 'در حال اندازه‌گیری پینگ واقعی…'}
            </span>
          </>
        ) : (
          <>
            <span className="ping-sweep-label">
              {sweep.cancelled
                ? `متوقف شد — ${sweep.done} سرور از ${sweep.total} سنجیده شد`
                : sweep.ok === 0
                  ? `هیچ‌کدام از ${sweep.done} سرور پاسخ ندادند`
                  : `${sweep.ok} سرور از ${sweep.done} پاسخ داد`}
            </span>
            {sweep.best != null && (
              <span className="ping-sweep-stat best">
                بهترین <b className="mono" dir="ltr">{sweep.best}</b>ms
              </span>
            )}
            {/* Redundant when nothing answered -- the label already says so. */}
            {failed > 0 && sweep.ok > 0 && (
              <span className="ping-sweep-stat failed">{failed} بی‌پاسخ</span>
            )}
            <button className="ping-sweep-close" onClick={onDismiss} title="بستن">
              <Icon name="close" size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Memoized so a ping/traffic tick that changes one card's `ms` (or unrelated
// App state) doesn't re-render every other card in a list that can run into
// the hundreds. Relies on `onSelect`/`onDelete`/`onPing`/`onContextMenu` being
// referentially stable (useCallback'd) across unrelated re-renders.
const ServerCard = React.memo(function ServerCard({ profile, active, ping, onSelect, onRequestDelete, onPing, onContextMenu }) {
  return (
    <div className={`server-card ${active ? 'active' : ''}`} onContextMenu={(e) => onContextMenu(e, profile)}>
      <span className="proto-tag">{profile.protocol}</span>
      <div className="info" onClick={() => onSelect(profile.id)}>
        <div className="name">
          {profile.favorite && <Icon name="star" size={10} className="fav-mark" />}
          {profile.name || profile.address}
        </div>
        <div className="addr mono">
          {profile.address}:{profile.port}
          {profile.totalBytes > 0 && <span className="usage-tag"> · {formatBytes(profile.totalBytes)}</span>}
        </div>
      </div>
      <PingPill entry={ping} onClick={() => onPing(profile.id)} />
      <button className="del" onClick={() => onRequestDelete(profile)} title="حذف">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
});

function ServerList({
  profiles, subscriptions, activeProfileId, connectionState, pings, updatingSubs, refreshingSubIds,
  onSelect, onDelete, onPing, onPingAll, onAdd,
  pingSweep, onCancelPingAll, onDismissPingSweep,
  onRefreshSubscription, onUpdateAllSubscriptions, onDeleteSubscription,
  onConnectTo, onDisconnect, onRenameProfile, onEditProfile, onUpdateSubscription, onToast,
  initialQuery, initialSortBy, initialCollapsed, onSessionChange,
}) {
  const [query, setQuery] = useState(initialQuery || '');
  const [sortBy, setSortBy] = useState(initialSortBy || 'default');
  const [collapsed, setCollapsed] = useState(initialCollapsed || {});
  const [ctxMenu, setCtxMenu] = useState(null);
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [testModal, setTestModal] = useState(null); // { sub, mode, autoConnectBest }

  // "Restore Previous Session" -- reports query/sortBy/collapsed up (debounced)
  // whenever they change, so App.jsx can persist them; a no-op when the
  // feature is off (onSessionChange is undefined in that case).
  useEffect(() => {
    if (!onSessionChange) return undefined;
    const t = setTimeout(() => onSessionChange({ query, sortBy, collapsed }), 300);
    return () => clearTimeout(t);
  }, [query, sortBy, collapsed, onSessionChange]);

  // Signals App.jsx's global shortcuts that something owned by this component
  // is holding the screen, so Ctrl+V doesn't add a config behind it and Ctrl+K
  // doesn't open the finder on top of it. Only the two surfaces that aren't
  // `.overlay` dialogs are declared here -- `modal` and `confirmDelete` render
  // through ModalShell, which raises the same flag itself. Both paths share one
  // counter, so whichever closes last is the one that lowers it.
  useModalOpenFlag(!!ctxMenu || !!testModal);

  const requestDeleteProfile = useCallback((profile) => {
    setConfirmDelete({ type: 'profile', id: profile.id, label: profile.name || profile.address });
  }, []);

  const requestDeleteSubscription = useCallback((sub) => {
    setConfirmDelete({ type: 'subscription', id: sub.id, label: sub.name });
  }, []);

  // Both "Ping All Servers" and "Connect to Best Server" run a scoped batch
  // through the shared Server Finder engine — only one batch can run at a
  // time app-wide, so bail out with a toast instead of hijacking one that's
  // already in flight (e.g. started from the finder).
  const startSubTest = useCallback((sub, mode, autoConnectBest) => {
    if (engine.getSnapshot().status !== 'idle') {
      onToast?.('یک تست دیگر در حال اجراست — صبر کن تا تمام شود', 'error');
      return;
    }
    const subProfiles = profiles.filter((p) => p.subId === sub.id);
    if (!subProfiles.length) {
      onToast?.('این ساب‌اسکریپشن کانفیگی ندارد', 'error');
      return;
    }
    setTestModal({ sub, mode, autoConnectBest });
  }, [profiles, onToast]);

  // useCallback'd (with only truly-hot-changing deps) so this stays a stable
  // reference across ping/traffic-driven re-renders, letting ServerCard's
  // React.memo actually skip re-rendering unaffected cards.
  const copyText = useCallback((text, msg) => {
    navigator.clipboard?.writeText(text)
      .then(() => onToast?.(msg))
      .catch(() => onToast?.('کپی ناموفق بود', 'error'));
  }, [onToast]);

  const openProfileMenu = useCallback((e, profile) => {
    e.preventDefault();
    const isActiveConnected = profile.id === activeProfileId && (connectionState === 'connected' || connectionState === 'connecting');
    const items = [
      isActiveConnected
        ? { icon: 'stop', label: 'قطع اتصال', onClick: () => onDisconnect() }
        : { icon: 'power', label: 'اتصال', onClick: () => onConnectTo(profile.id) },
      { icon: 'gauge', label: 'نمایش پینگ', onClick: () => onPing(profile.id) },
      { icon: 'edit', label: 'ویرایش', sepBefore: true, onClick: () => setModal({ type: 'editProfile', profile }) },
      { icon: 'edit', label: 'تغییر نام', onClick: () => setModal({ type: 'renameProfile', profile }) },
      { icon: 'copy', label: 'کپی', onClick: () => copyText(profile.link, 'لینک کپی شد') },
      { icon: 'arrowUp', label: 'اشتراک‌گذاری / خروجی گرفتن', onClick: () => copyText(profile.link, 'لینک برای اشتراک‌گذاری کپی شد') },
      { icon: 'qrcode', label: 'اشتراک‌گذاری با QR', onClick: () => setModal({ type: 'qr', value: profile.link, title: profile.name || profile.address, subtitle: `${profile.address}:${profile.port}` }) },
      { icon: 'trash', label: 'حذف', danger: true, sepBefore: true, onClick: () => requestDeleteProfile(profile) },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, title: profile.name || profile.address, items });
  }, [activeProfileId, connectionState, onDisconnect, onConnectTo, onPing, requestDeleteProfile, copyText]);

  const openSubMenu = useCallback((e, sub) => {
    e.preventDefault();
    const items = [
      { icon: 'bolt', label: 'اتصال به بهترین سرور', onClick: () => startSubTest(sub, 'ping', true) },
      { icon: 'gauge', label: 'پینگ گرفتن از تمام سرورها', onClick: () => startSubTest(sub, 'ping', false) },
      { icon: 'refresh', label: 'به‌روزرسانی ساب‌اسکریپشن', sepBefore: true, onClick: () => onRefreshSubscription(sub.id) },
      { icon: 'edit', label: 'ویرایش', sepBefore: true, onClick: () => setModal({ type: 'editSub', sub }) },
      { icon: 'edit', label: 'تغییر نام', onClick: () => setModal({ type: 'renameSub', sub }) },
      { icon: 'copy', label: 'کپی لینک', onClick: () => copyText(sub.url, 'لینک ساب‌اسکریپشن کپی شد') },
      { icon: 'qrcode', label: 'اشتراک‌گذاری با QR', onClick: () => setModal({ type: 'qr', value: sub.url, title: sub.name, subtitle: `${sub.configCount ?? 0} کانفیگ` }) },
      { icon: 'info', label: 'مشاهده اطلاعات', onClick: () => setModal({ type: 'details', sub }) },
      { icon: 'trash', label: 'حذف', danger: true, sepBefore: true, onClick: () => requestDeleteSubscription(sub) },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, title: sub.name, items });
  }, [onRefreshSubscription, requestDeleteSubscription, copyText, startSubTest]);

  // Only the ping sort actually reads measurements. Making `pings` an
  // unconditional dependency meant a landing measurement re-filtered and
  // re-sorted the whole list even while sorted by name -- work whose result was
  // identical every time. `null` here is a stable value, so the memo holds.
  const pingsForSort = sortBy === 'ping' ? pings : null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = !q ? profiles : profiles.filter((p) =>
      (p.name || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)
    );
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (pingsForSort) {
      list = [...list].sort((a, b) => {
        // Unmeasured and unreachable both sink to the bottom rather than
        // pretending to be fast.
        const va = pingMs(pingsForSort[a.id]);
        const vb = pingMs(pingsForSort[b.id]);
        return (va == null ? Infinity : va) - (vb == null ? Infinity : vb);
      });
    }
    return list;
  }, [profiles, query, sortBy, pingsForSort]);

  const groups = useMemoGroups(filtered, subscriptions);

  // Measures exactly what is on screen: with a search or a filter active,
  // sweeping the servers the user cannot see is work they did not ask for.
  const sweeping = !!pingSweep && pingSweep.running;
  const runPingAll = useCallback(() => {
    if (sweeping) return;
    onPingAll(filtered.map((p) => p.id));
  }, [sweeping, onPingAll, filtered]);

  if (!profiles.length) {
    return (
      <div className="empty-state">
        <div className="empty-glyph">
          <Icon name="signal" size={30} strokeWidth={2.25} />
        </div>
        <h3>هنوز سروری وصل نکرده‌ای</h3>
        <p>یک لینک کانفیگ یا آدرس ساب‌اسکریپشن اضافه کن تا اولین اتصالت رو بزنی.</p>
        <button className="btn primary empty-cta" onClick={onAdd}>
          <Icon name="plus" size={15} />
          افزودن کانفیگ
        </button>
      </div>
    );
  }

  return (
    <div className="list-wrap">
      <div className="list-toolbar">
        <div className="search-box">
          <Icon name="search" size={14} className="search-icon" />
          <input
            className="search-input"
            placeholder="جست‌وجو…"
            aria-label="جست‌وجو در کانفیگ‌ها"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="sort-select"
          aria-label="ترتیب فهرست"
          title="ترتیب فهرست"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="default">پیش‌فرض</option>
          <option value="ping">پینگ</option>
          <option value="name">نام</option>
        </select>
        <button
          className={`icon-btn ping-all ${sweeping ? 'busy' : ''}`}
          onClick={sweeping ? onCancelPingAll : runPingAll}
          disabled={sweeping && pingSweep.cancelled}
          title={sweeping
            ? (pingSweep.cancelled ? 'در حال توقف…' : `توقف اندازه‌گیری (${pingSweep.done} از ${pingSweep.total})`)
            : 'اندازه‌گیری پینگ واقعی همه‌ی سرورها'}
        >
          {sweeping
            ? <SweepRing done={pingSweep.done} total={pingSweep.total} stopping={pingSweep.cancelled} />
            : <Icon name="gauge" size={15} />}
        </button>
      </div>

      <SweepStrip sweep={pingSweep} onDismiss={onDismissPingSweep} />

      {subscriptions.length > 0 && (
        <button className="update-all-btn" onClick={onUpdateAllSubscriptions} disabled={updatingSubs}>
          {updatingSubs && <span className="icon-spinner" aria-hidden="true" />}
          {updatingSubs ? 'در حال به‌روزرسانی…' : 'به‌روزرسانی همه‌ی ساب‌اسکریپشن‌ها'}
        </button>
      )}

      <div className="list">
        {/* A filter that matches nothing used to render an empty box and no
            explanation -- indistinguishable from the list having failed to
            load. The toolbar stays put so the way out is where the way in was. */}
        {groups.length === 0 && (
          <div className="list-empty">
            <Icon name="search" size={22} />
            <p>
              {query.trim()
                // <bdi> so a Latin or mixed query can't reorder the Farsi
                // sentence it is quoted inside.
                ? <>سروری با «<bdi>{query.trim()}</bdi>» پیدا نشد</>
                : 'سروری برای نمایش نیست'}
            </p>
            {query.trim() && (
              <button className="btn" onClick={() => setQuery('')}>پاک‌کردن جست‌وجو</button>
            )}
          </div>
        )}
        {groups.map((group) => {
          const usageInfo = !group.local ? subUsageInfo(group.sub) : null;
          const critical = usageInfo && (usageInfo.expired || usageInfo.exhausted);
          return (
          <div key={group.key} className={`server-group ${group.local ? 'local-group' : ''}`}>
            {(group.sub || group.local) && (
              <div
                className={`group-head ${group.local ? 'local' : ''} ${critical ? 'critical' : ''}`}
                onContextMenu={!group.local ? (e) => openSubMenu(e, group.sub) : undefined}
              >
                <div className="group-head-row">
                  <button
                    className="group-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] }))}
                  >
                    <span className={`chev ${collapsed[group.key] ? 'closed' : ''}`}>
                      <Icon name="chevron" size={12} />
                    </span>
                    {group.local && <Icon name="folder" size={12} className="local-icon" />}
                    <span className="group-name">{group.local ? 'لوکال' : group.sub.name}</span>
                    <span className="group-stats">
                      {group.stats.totalBytes > 0 && (
                        <span className="stat-chip size">{formatBytes(group.stats.totalBytes)}</span>
                      )}
                      <GroupPing items={group.items} pings={pings} />
                    </span>
                    {!group.local && <span className="group-meta">{relativeTime(group.sub.lastUpdated)}</span>}
                  </button>
                  {!group.local && (
                    <>
                      <button
                        className="group-action"
                        onClick={() => onRefreshSubscription(group.sub.id)}
                        disabled={refreshingSubIds?.has(group.sub.id)}
                        title="به‌روزرسانی"
                      >
                        {refreshingSubIds?.has(group.sub.id)
                          ? <span className="icon-spinner" aria-hidden="true" />
                          : <Icon name="refresh" size={13} />}
                      </button>
                      <button className="group-action danger" onClick={() => requestDeleteSubscription(group.sub)} title="حذف ساب‌اسکریپشن">
                        <Icon name="close" size={13} />
                      </button>
                    </>
                  )}
                </div>
                {usageInfo && (
                  <div className="sub-usage">
                    <div className="usage-bar-track">
                      <div
                        className={`usage-bar-fill ${critical ? 'critical' : ''}`}
                        style={{ transform: `scaleX(${Math.max(usageInfo.total > 0 ? usageInfo.pct : 0, usageInfo.total > 0 ? 2 : 0) / 100})` }}
                      />
                    </div>
                    <div className="usage-row">
                      <span className="usage-text">
                        {usageInfo.total > 0
                          ? `${formatBytes(usageInfo.used)} / ${formatBytes(usageInfo.total)}`
                          : formatBytes(usageInfo.used)}
                      </span>
                      {usageInfo.daysLeft !== null && (
                        <span className={`usage-expiry ${usageInfo.expired ? 'critical' : ''}`}>
                          {usageInfo.expired ? 'منقضی شده' : `${usageInfo.daysLeft} روز تا انقضا`}
                        </span>
                      )}
                    </div>
                    {critical && (
                      <div className="usage-warn">
                        <Icon name="info" size={11} />
                        {usageInfo.expired ? 'این ساب‌اسکریپشن منقضی شده است' : 'حجم این ساب‌اسکریپشن به پایان رسیده است'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!collapsed[group.key] && group.items.map((p) => (
              <ServerCard
                key={p.id}
                profile={p}
                active={p.id === activeProfileId}
                ping={pings[p.id]}
                onSelect={onSelect}
                onRequestDelete={requestDeleteProfile}
                onPing={onPing}
                onContextMenu={openProfileMenu}
              />
            ))}
          </div>
          );
        })}
      </div>

      {ctxMenu && <ContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} />}

      {modal?.type === 'renameProfile' && (
        <RenameModal
          title="تغییر نام کانفیگ"
          initialValue={modal.profile.name}
          onClose={() => setModal(null)}
          onSubmit={(name) => onRenameProfile(modal.profile.id, name)}
        />
      )}
      {modal?.type === 'editProfile' && (
        <EditProfileModal
          profile={modal.profile}
          onClose={() => setModal(null)}
          onSubmit={(link) => onEditProfile(modal.profile.id, link)}
        />
      )}
      {modal?.type === 'renameSub' && (
        <RenameModal
          title="تغییر نام ساب‌اسکریپشن"
          initialValue={modal.sub.name}
          onClose={() => setModal(null)}
          onSubmit={(name) => onUpdateSubscription(modal.sub.id, { name })}
        />
      )}
      {modal?.type === 'editSub' && (
        <EditSubscriptionModal
          sub={modal.sub}
          onClose={() => setModal(null)}
          onSubmit={(patch) => onUpdateSubscription(modal.sub.id, patch)}
        />
      )}
      {modal?.type === 'details' && (
        <SubscriptionDetailsModal sub={modal.sub} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'qr' && (
        <QrModal
          title={modal.title}
          subtitle={modal.subtitle}
          value={modal.value}
          onClose={() => setModal(null)}
          onToast={onToast}
        />
      )}

      {testModal && (
        <SubTestModal
          sub={testModal.sub}
          profiles={profiles}
          mode={testModal.mode}
          autoConnectBest={testModal.autoConnectBest}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onConnect={onConnectTo}
          onClose={() => setTestModal(null)}
          onToast={onToast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.type === 'subscription' ? 'حذف ساب‌اسکریپشن' : 'حذف کانفیگ'}
          message={
            `آیا از حذف ${confirmDelete.label ? `"${confirmDelete.label}"` : 'این مورد'} مطمئن هستید؟ ` +
            'این عملیات غیرقابل بازگشت است.'
          }
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete.type === 'subscription') onDeleteSubscription(confirmDelete.id);
            else onDelete(confirmDelete.id);
          }}
        />
      )}
    </div>
  );
}

// Memoized for the same reason ServerCard is, one level up: App re-renders on
// every 1s traffic tick, and without this the whole sidebar body -- toolbar,
// every group header, every usage bar -- was rebuilt and reconciled once a
// second for a number rendered in the footer. Every function prop it takes is
// already useCallback'd in App, and the `initial*` props come from a ref, so
// the comparison actually holds.
export default React.memo(ServerList);

function useMemoGroups(filtered, subscriptions) {
  return useMemo(() => {
    const bySub = new Map();
    const noGroup = [];
    // Groups are rendered by walking `subscriptions`, so a profile tagged with
    // a subId that no longer exists (restored backup, data file from an older
    // build) would land in a group that never renders -- invisible in the list
    // while still counted everywhere else. Treat those as local configs.
    const knownSubIds = new Set(subscriptions.map((s) => s.id));
    for (const p of filtered) {
      if (p.subId && knownSubIds.has(p.subId)) {
        if (!bySub.has(p.subId)) bySub.set(p.subId, []);
        bySub.get(p.subId).push(p);
      } else {
        noGroup.push(p);
      }
    }
    const groups = [];
    if (noGroup.length) groups.push({ key: 'none', sub: null, local: true, items: noGroup, stats: groupStats(noGroup) });
    for (const sub of subscriptions) {
      const items = bySub.get(sub.id) || [];
      if (items.length) groups.push({ key: sub.id, sub, items, stats: groupStats(items) });
    }
    return groups;
  }, [filtered, subscriptions]);
}
