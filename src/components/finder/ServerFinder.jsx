import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Icon from '../Icon.jsx';
import ContextMenu from '../ContextMenu.jsx';
import { useModalOpenFlag } from '../ModalShell.jsx';
import * as engine from '../../finder/testEngine.js';
import { countryOf } from '../../utils/geo.js';
import { PRIORITIES, priorityByKey, healthScore, extractMetrics, recommend } from '../../utils/score.js';
import { MODES, loadPrefs, savePrefs, loadRecent, saveRecent } from './finderShared.js';
import FinderToolbar from './FinderToolbar.jsx';
import FinderTestBar from './FinderTestBar.jsx';
import FinderCard from './FinderCard.jsx';
import TestDashboard from './TestDashboard.jsx';

// ---- The Smart Server Finder ----
//
// A command-palette-style overlay (Ctrl+K) over the whole config library:
// search and facet filters on top, a test launcher in the middle, result
// cards below, and a live dashboard view while a batch runs. The test batches
// themselves live in src/finder/testEngine.js -- a module store outside React
// -- so closing this overlay never stops a running batch, and reopening it
// mid-batch lands straight on the live dashboard.
//
// Decisions worth knowing before editing:
//
//   selection is an id, not an index    while a batch runs the list re-sorts
//     itself under the keyboard (scores arrive and reorder it). An index kept
//     "selected" pointing at whatever happened to slide into that slot; the
//     id keeps it on the server the user actually chose.
//   one keyboard surface               every key the finder answers is in the
//     single window listener below, layered: context menu first, then the
//     dashboard view, then the list. That ordering is what Esc "one layer at
//     a time" falls out of, with no stopPropagation tricks.
//   dialog semantics                   the overlay is a real dialog: focus is
//     trapped inside (Tab cycles), returned to the opener on close, and
//     `modalOpen` is raised through the same counter every other dialog uses
//     so the app's global shortcuts stay out while the finder owns the screen.
//   prefs persist                      mode / priority / sort survive a
//     close/reopen (localStorage soul.finder.prefs.v1). Filters deliberately
//     do not: a stale country filter that hides everything looks exactly like
//     a broken finder.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function ServerFinder({ profiles, subscriptions, activeProfileId, connectionState, onClose, onConnect, onToggleFavorite }) {
  const t = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const prefsRef = useRef(null);
  if (prefsRef.current === null) prefsRef.current = loadPrefs();

  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [recent, setRecent] = useState(loadRecent);
  const [chips, setChips] = useState({ fav: false, tested: false, protocols: [] });
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState({ sub: '', country: '', network: '', security: '' });
  const [sortBy, setSortBy] = useState(prefsRef.current.sortBy);
  const [mode, setMode] = useState(prefsRef.current.mode);
  const [priority, setPriority] = useState(prefsRef.current.priority);
  const [selectedId, setSelectedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  // Reopening the finder mid-batch lands straight on the live dashboard.
  const [view, setView] = useState(() => (engine.getSnapshot().status !== 'idle' ? 'dash' : 'list'));
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, profile}
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const logRef = useRef(null);
  const dialogRef = useRef(null);
  // Captured during the first render, before the search input's autoFocus is
  // committed -- same trick as ModalShell, and for the same reason: an effect
  // runs too late to see who really had focus before the finder opened.
  const restoreRef = useRef(undefined);
  if (restoreRef.current === undefined) restoreRef.current = document.activeElement;
  // Whether the press that is about to become a click STARTED on the backdrop
  // (same guard as ModalShell). Without it, selecting text in the search box
  // and releasing the mouse past the panel's edge counted as a backdrop click
  // and closed the finder mid-thought.
  const backdropPressRef = useRef(false);

  useModalOpenFlag(true);
  useEffect(() => () => {
    const el = restoreRef.current;
    if (el && el.isConnected && typeof el.focus === 'function') el.focus();
  }, []);

  useEffect(() => {
    savePrefs({ mode, priority, sortBy });
  }, [mode, priority, sortBy]);

  const subsById = useMemo(() => Object.fromEntries(subscriptions.map((s) => [s.id, s])), [subscriptions]);
  const running = t.status === 'running' || t.status === 'paused' || t.status === 'stopping';

  useEffect(() => {
    engine.setProfileNames(Object.fromEntries(profiles.map((p) => [p.id, p.name || p.address])));
  }, [profiles]);

  // The distinct values that exist in the data drive the filter UI.
  const facets = useMemo(() => {
    const protocols = new Map();
    const countries = new Map();
    const networks = new Set();
    const securities = new Set();
    for (const p of profiles) {
      protocols.set(p.protocol, (protocols.get(p.protocol) || 0) + 1);
      const geo = countryOf(p);
      if (geo) countries.set(geo.iso, geo);
      if (p.network) networks.add(p.network);
      if (p.security) securities.add(p.security);
    }
    return {
      protocols: [...protocols.entries()].sort((a, b) => b[1] - a[1]),
      countries: [...countries.values()].sort((a, b) => a.label.localeCompare(b.label, 'fa')),
      networks: [...networks],
      securities: [...securities],
    };
  }, [profiles]);

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = profiles.filter((p) => {
      if (chips.fav && !p.favorite) return false;
      if (chips.tested && t.results[p.id]?.status !== 'ok') return false;
      if (chips.protocols.length && !chips.protocols.includes(p.protocol)) return false;
      if (adv.sub && p.subId !== adv.sub) return false;
      if (adv.network && p.network !== adv.network) return false;
      if (adv.security && p.security !== adv.security) return false;
      const geo = countryOf(p);
      if (adv.country && geo?.iso !== adv.country) return false;
      if (tokens.length) {
        const sub = subsById[p.subId];
        const hay = [p.name, p.address, p.protocol, p.network, p.security, sub?.name, geo?.label, geo?.iso]
          .filter(Boolean).join(' ').toLowerCase();
        if (!tokens.every((tk) => hay.includes(tk))) return false;
      }
      return true;
    });

    const val = (p) => {
      const r = t.results[p.id];
      const m = extractMetrics(r);
      switch (sortBy) {
        case 'score': { const s = healthScore(r, priority); return s == null ? 1e9 : -s; }
        case 'ping': return r?.ping?.avg ?? m.latency ?? 1e9;
        case 'real': return r?.real?.avg ?? 1e9;
        case 'down': return m.down == null ? 1e9 : -m.down;
        case 'loss': return m.loss ?? 1e9;
        case 'stability': return m.stability == null ? 1e9 : -m.stability;
        case 'boot': return m.boot ?? 1e9;
        case 'fav': return p.favorite ? 0 : 1;
        case 'recent': return p.lastUsedAt ? -p.lastUsedAt : 1e15;
        default: return 0;
      }
    };
    if (sortBy === 'name') list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fa'));
    else if (sortBy === 'country') list = [...list].sort((a, b) => (countryOf(a)?.label || '～').localeCompare(countryOf(b)?.label || '～', 'fa'));
    else list = [...list].sort((a, b) => val(a) - val(b));
    return list;
  }, [profiles, query, chips, adv, sortBy, priority, t.results, subsById]);

  const selIdx = useMemo(
    () => (selectedId == null ? -1 : filtered.findIndex((p) => p.id === selectedId)),
    [filtered, selectedId]
  );

  const commitRecent = useCallback((q) => {
    const v = q.trim();
    if (!v) return;
    setRecent((r) => {
      const next = [v, ...r.filter((x) => x !== v)].slice(0, 8);
      saveRecent(next);
      return next;
    });
  }, []);

  // Stable (id-taking) handlers so FinderCard's React.memo isn't defeated by
  // a fresh closure every render -- critical since `t.results` (and therefore
  // this whole component) can re-render up to once per animation frame while
  // a test batch is running.
  const handleCardExpand = useCallback((id) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);
  const handleCardConnect = useCallback((id) => {
    commitRecent(query);
    onConnect(id);
  }, [commitRecent, onConnect, query]);
  const handleCardContext = useCallback((e, profile) => {
    e.preventDefault();
    setSelectedId(profile.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, profile });
  }, []);
  // A single-server retest stays in the list view: the card itself narrates
  // its phases, and yanking the user to the dashboard for one server made the
  // quick "test just this one again" gesture feel like starting over.
  const handleRetest = useCallback((id, m) => {
    if (engine.getSnapshot().status !== 'idle') return;
    engine.testOne(id, m || mode);
  }, [mode]);

  const startBatch = useCallback(() => {
    if (!filtered.length || running) return;
    commitRecent(query);
    engine.startBatch(filtered.map((p) => p.id), mode);
    setView('dash');
  }, [filtered, running, commitRecent, query, mode]);

  const recommendation = useMemo(() => {
    if (running) return null;
    return recommend(filtered, t.results, priority);
  }, [filtered, t.results, priority, running]);

  const testedCount = useMemo(
    () => filtered.filter((p) => t.results[p.id]?.status === 'ok').length,
    [filtered, t.results]
  );

  // Move the keyboard selection and keep it on screen. The cards are the
  // direct children of the listbox, in `filtered` order, so index addressing
  // is safe here.
  const moveSelection = useCallback((delta, absolute) => {
    if (!filtered.length) return;
    const cur = selIdx < 0 ? (delta > 0 ? -1 : filtered.length) : selIdx;
    const next = absolute != null
      ? Math.max(0, Math.min(filtered.length - 1, absolute))
      : Math.max(0, Math.min(filtered.length - 1, cur + delta));
    setSelectedId(filtered[next].id);
    listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  }, [filtered, selIdx]);

  // The one keyboard surface -- see the header note on layering.
  useEffect(() => {
    const onKey = (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (ctxMenu) {
        if (e.key === 'Escape') setCtxMenu(null);
        return;
      }
      if (view === 'dash') {
        // The dashboard is its own workspace: Esc returns to the list,
        // Space toggles pause while a batch is running.
        if (e.key === 'Escape') setView('list');
        else if (e.key === ' ' && !inField) {
          e.preventDefault();
          const st = engine.getSnapshot().status;
          if (st === 'running') engine.pause();
          else if (st === 'paused') engine.resume();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (inField && query) { setQuery(''); return; }
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        moveSelection(e.key === 'PageDown' ? 8 : -8);
      } else if (e.key === 'Home' && !inField) {
        e.preventDefault();
        moveSelection(0, 0);
      } else if (e.key === 'End' && !inField) {
        e.preventDefault();
        moveSelection(0, filtered.length - 1);
      } else if (e.key === 'Enter' && !inField) {
        const p = filtered[selIdx];
        if (p) { commitRecent(query); onConnect(p.id); }
      } else if (e.key === ' ' && !inField) {
        e.preventDefault();
        const p = filtered[selIdx];
        if (p) handleCardExpand(p.id);
      } else if ((e.key === 'f' || e.key === 'F') && !inField) {
        const p = filtered[selIdx];
        if (p) onToggleFavorite(p);
      } else if ((e.key === 't' || e.key === 'T') && !inField) {
        const p = filtered[selIdx];
        if (p) handleRetest(p.id);
      } else if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selIdx, query, onClose, onConnect, onToggleFavorite, commitRecent, view, ctxMenu, moveSelection, handleCardExpand, handleRetest]);

  // Focus trap: Tab cycles inside the finder. Escape is handled by the window
  // listener above (it has to see the key even when nothing inside the dialog
  // is focused), so only Tab is intercepted here.
  const handleTrapKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return;
    const box = dialogRef.current;
    if (!box) return;
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
  }, []);

  // The dashboard view has no autoFocus field, so give the trap a starting
  // point whenever the view flips and focus was left outside the dialog.
  useEffect(() => {
    const box = dialogRef.current;
    if (!box || box.contains(document.activeElement)) return;
    (box.querySelector(FOCUSABLE) || box).focus();
  }, [view]);

  // Live log autoscroll.
  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [t.logs.length, logOpen]);

  const handleSearchFocus = useCallback(() => setSearchFocused(true), []);
  const handleSearchBlur = useCallback(() => setTimeout(() => setSearchFocused(false), 150), []);
  const handleQueryCommit = useCallback(() => commitRecent(query), [commitRecent, query]);
  const handlePickRecent = useCallback((r) => setQuery(r), []);
  const handleClearRecent = useCallback(() => { setRecent([]); saveRecent([]); }, []);
  const handleToggleAdv = useCallback(() => setAdvOpen((v) => !v), []);
  const handleToggleLog = useCallback(() => setLogOpen((v) => !v), []);
  const handleOpenDash = useCallback(() => setView('dash'), []);

  const eta = engine.etaMs();
  const progress = t.total ? Math.round((t.done / t.total) * 100) : 0;

  const ctxItems = ctxMenu ? [
    { icon: 'power', label: 'اتصال', onClick: () => { commitRecent(query); onConnect(ctxMenu.profile.id); } },
    {
      icon: 'star',
      label: ctxMenu.profile.favorite ? 'حذف از موردعلاقه‌ها' : 'افزودن به موردعلاقه‌ها',
      onClick: () => onToggleFavorite(ctxMenu.profile),
    },
    {
      icon: 'copy',
      label: 'کپی آدرس',
      onClick: () => navigator.clipboard?.writeText(`${ctxMenu.profile.address}:${ctxMenu.profile.port}`).catch(() => {}),
    },
    ...MODES.map((mo, i) => ({
      icon: mo.icon,
      label: mo.title,
      sepBefore: i === 0,
      disabled: running,
      onClick: () => handleRetest(ctxMenu.profile.id, mo.key),
    })),
  ] : null;

  return (
    <div
      className="finder-overlay"
      onMouseDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropPressRef.current) onClose();
        backdropPressRef.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className={`finder ${view === 'dash' ? 'dash-mode' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={view === 'dash' ? 'داشبورد تست سرورها' : 'سرور یاب هوشمند'}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
      >
        {view === 'dash' ? (
          <TestDashboard
            t={t}
            profiles={profiles}
            priority={priority}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            onBack={() => setView('list')}
            onConnect={onConnect}
            onRetest={() => {
              if (t.batchIds.length && t.status === 'idle') {
                engine.startBatch(t.batchIds, t.lastBatch?.mode || mode);
              }
            }}
          />
        ) : (
          <>
            <FinderToolbar
              searchRef={searchRef}
              query={query}
              onQueryChange={setQuery}
              onQueryCommit={handleQueryCommit}
              searchFocused={searchFocused}
              onSearchFocus={handleSearchFocus}
              onSearchBlur={handleSearchBlur}
              recent={recent}
              onPickRecent={handlePickRecent}
              onClearRecent={handleClearRecent}
              profilesCount={profiles.length}
              chips={chips}
              onChipsChange={setChips}
              facets={facets}
              subscriptions={subscriptions}
              advOpen={advOpen}
              onToggleAdv={handleToggleAdv}
              adv={adv}
              onAdvChange={setAdv}
              sortBy={sortBy}
              onSortChange={setSortBy}
              onClose={onClose}
            />

            <FinderTestBar
              t={t}
              running={running}
              mode={mode}
              onModeChange={setMode}
              priority={priority}
              onPriorityChange={setPriority}
              filteredCount={filtered.length}
              onStart={startBatch}
              eta={eta}
              progress={progress}
              logOpen={logOpen}
              onToggleLog={handleToggleLog}
              onOpenDash={handleOpenDash}
            />

            {recommendation && !running && testedCount > 0 && (
              <div className="rec-banner">
                <div className="rec-icon"><Icon name={priorityByKey(priority).icon} size={16} /></div>
                <div className="rec-text">
                  <span className="rec-title">
                    پیشنهاد برای «{priorityByKey(priority).label}»: {recommendation.profile.name || recommendation.profile.address}
                  </span>
                  <span className="rec-sub">امتیاز سلامت {recommendation.score} از ۱۰۰ · بر پایه‌ی {testedCount} سرور تست‌شده</span>
                </div>
                <button
                  className="btn primary mini"
                  disabled={recommendation.profile.id === activeProfileId && connectionState === 'connected'}
                  onClick={() => handleCardConnect(recommendation.profile.id)}
                >
                  اتصال
                </button>
              </div>
            )}

            <div
              className="finder-body"
              ref={listRef}
              role="listbox"
              aria-label="نتایج جست‌وجوی سرور"
              aria-activedescendant={selectedId != null && selIdx >= 0 ? `fcard-${selectedId}` : undefined}
            >
              {profiles.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-glyph"><Icon name="signal" size={30} strokeWidth={2.25} /></div>
                  <h3>هنوز کانفیگی نداری</h3>
                  <p>اول از پنل اصلی یک کانفیگ یا ساب‌اسکریپشن اضافه کن.</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-glyph"><Icon name="search" size={28} strokeWidth={2.25} /></div>
                  <h3>چیزی پیدا نشد</h3>
                  <p>عبارت دیگری امتحان کن یا فیلترها را کم کن.</p>
                  <button
                    className="btn empty-cta"
                    onClick={() => {
                      setQuery('');
                      setChips({ fav: false, tested: false, protocols: [] });
                      setAdv({ sub: '', country: '', network: '', security: '' });
                    }}
                  >
                    پاک کردن همه‌ی فیلترها
                  </button>
                </div>
              ) : (
                filtered.map((p) => {
                  const r = t.results[p.id];
                  return (
                    <FinderCard
                      key={p.id}
                      profile={p}
                      sub={subsById[p.subId]}
                      result={r}
                      selected={p.id === selectedId}
                      expanded={expandedId === p.id}
                      recommended={recommendation?.profile.id === p.id}
                      isActive={p.id === activeProfileId && connectionState === 'connected'}
                      priority={priority}
                      engineIdle={t.status === 'idle'}
                      onSelect={setSelectedId}
                      onExpand={handleCardExpand}
                      onConnect={handleCardConnect}
                      onFavorite={onToggleFavorite}
                      onRetest={handleRetest}
                      onContext={handleCardContext}
                    />
                  );
                })
              )}
            </div>

            {logOpen && (
              <div className="live-log mono" ref={logRef}>
                {t.logs.slice(-60).map((l, i) => (
                  <div key={i} className={`log-line tone-${l.tone}`}>
                    <span className="log-t">{new Date(l.t).toLocaleTimeString('fa-IR')}</span>
                    {l.msg}
                  </div>
                ))}
              </div>
            )}

            <div className="finder-foot">
              <span><kbd>↑↓</kbd> حرکت</span>
              <span><kbd>Enter</kbd> اتصال</span>
              <span><kbd>Space</kbd> جزئیات</span>
              <span><kbd>F</kbd> موردعلاقه</span>
              <span><kbd>T</kbd> تست</span>
              <span><kbd>/</kbd> جست‌وجو</span>
              {testedCount > 0 && !running && (
                <button className="foot-clear" onClick={engine.clearResults}>پاک کردن نتایج</button>
              )}
            </div>
          </>
        )}

        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            title={ctxMenu.profile.name || ctxMenu.profile.address}
            items={ctxItems}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
