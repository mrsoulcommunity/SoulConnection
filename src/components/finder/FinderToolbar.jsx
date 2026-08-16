import React from 'react';
import Icon from '../Icon.jsx';
import { SORTS } from './finderShared.js';

// The finder's filtering surface: search box with recent queries, the quick
// filter chips, the advanced panel, and the sort axis. Fully presentational
// -- every piece of state lives in ServerFinder and arrives as props, so this
// file is only about layout.
export default function FinderToolbar({
  searchRef,
  query, onQueryChange, onQueryCommit,
  searchFocused, onSearchFocus, onSearchBlur,
  recent, onPickRecent, onClearRecent,
  profilesCount,
  chips, onChipsChange,
  facets, subscriptions,
  advOpen, onToggleAdv, adv, onAdvChange,
  sortBy, onSortChange,
  onClose,
}) {
  const activeChips = chips.fav || chips.tested || chips.protocols.length > 0;
  const advCount = ['sub', 'country', 'network', 'security'].filter((k) => adv[k]).length;

  return (
    <>
      {/* ---- search head ---- */}
      <div className="finder-head">
        <div className="finder-brand" aria-hidden="true">
          <Icon name="radar" size={16} />
          <span>سرور یاب</span>
        </div>
        <div className="finder-search">
          <Icon name="search" size={17} className="fs-icon" />
          <input
            ref={searchRef}
            autoFocus
            value={query}
            aria-label="جست‌وجوی سرور"
            placeholder="جست‌وجوی نام، کشور، شهر، پروتکل، ساب‌اسکریپشن…"
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={onSearchFocus}
            onBlur={onSearchBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') { onQueryCommit(); e.target.blur(); } }}
          />
          {query && (
            <button className="fs-clear" onClick={() => onQueryChange('')} title="پاک کردن" aria-label="پاک کردن جست‌وجو">
              <Icon name="close" size={13} />
            </button>
          )}
          <kbd className="fs-kbd">Esc</kbd>
        </div>
        <button className="icon-btn ghost finder-close" onClick={onClose} title="بستن (Esc)" aria-label="بستن سرور یاب">
          <Icon name="close" size={16} />
        </button>
      </div>

      {searchFocused && !query && recent.length > 0 && (
        <div className="recent-row">
          <Icon name="history" size={12} />
          {recent.map((r) => (
            <button key={r} className="recent-chip" onMouseDown={() => onPickRecent(r)}>{r}</button>
          ))}
          <button className="recent-clear" onMouseDown={onClearRecent}>پاک کردن</button>
        </div>
      )}

      {/* ---- quick filters + sort ---- */}
      <div className="chip-row">
        <button
          className={`chip ${!activeChips ? 'on' : ''}`}
          onClick={() => onChipsChange({ fav: false, tested: false, protocols: [] })}
        >
          همه <span className="chip-n mono">{profilesCount}</span>
        </button>
        <button
          className={`chip ${chips.fav ? 'on' : ''}`}
          aria-pressed={chips.fav}
          onClick={() => onChipsChange({ ...chips, fav: !chips.fav })}
        >
          <Icon name="star" size={12} /> موردعلاقه
        </button>
        <button
          className={`chip ${chips.tested ? 'on' : ''}`}
          aria-pressed={chips.tested}
          onClick={() => onChipsChange({ ...chips, tested: !chips.tested })}
        >
          <Icon name="check" size={12} /> تست‌شده
        </button>
        {facets.protocols.slice(0, 4).map(([proto, n]) => (
          <button
            key={proto}
            className={`chip mono ${chips.protocols.includes(proto) ? 'on' : ''}`}
            aria-pressed={chips.protocols.includes(proto)}
            onClick={() => onChipsChange({
              ...chips,
              protocols: chips.protocols.includes(proto)
                ? chips.protocols.filter((x) => x !== proto)
                : [...chips.protocols, proto],
            })}
          >
            {proto} <span className="chip-n mono">{n}</span>
          </button>
        ))}

        <div className="chip-row-end">
          <select
            className="finder-select sort-axis"
            value={sortBy}
            aria-label="مرتب‌سازی نتایج"
            title="مرتب‌سازی نتایج"
            onChange={(e) => onSortChange(e.target.value)}
          >
            {SORTS.map(([k, l]) => <option key={k} value={k}>ترتیب: {l}</option>)}
          </select>
          <button
            className={`chip adv-toggle ${advOpen || advCount ? 'on' : ''}`}
            aria-expanded={advOpen}
            onClick={onToggleAdv}
          >
            <Icon name="filter" size={12} /> فیلتر پیشرفته
            {advCount > 0 && <span className="chip-n mono">{advCount}</span>}
            <Icon name="chevron" size={11} className={advOpen ? 'flip' : ''} />
          </button>
        </div>
      </div>

      {/* ---- advanced filters ---- */}
      {advOpen && (
        <div className="adv-panel">
          <label>
            <span>ساب‌اسکریپشن</span>
            <select className="finder-select" value={adv.sub} onChange={(e) => onAdvChange({ ...adv, sub: e.target.value })}>
              <option value="">همه</option>
              {subscriptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            <span>کشور</span>
            <select className="finder-select" value={adv.country} onChange={(e) => onAdvChange({ ...adv, country: e.target.value })}>
              <option value="">همه</option>
              {facets.countries.map((c) => <option key={c.iso} value={c.iso}>{c.flag} {c.label}</option>)}
            </select>
          </label>
          {facets.networks.length > 1 && (
            <label>
              <span>شبکه</span>
              <select className="finder-select" value={adv.network} onChange={(e) => onAdvChange({ ...adv, network: e.target.value })}>
                <option value="">همه</option>
                {facets.networks.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          {facets.securities.length > 1 && (
            <label>
              <span>امنیت</span>
              <select className="finder-select" value={adv.security} onChange={(e) => onAdvChange({ ...adv, security: e.target.value })}>
                <option value="">همه</option>
                {facets.securities.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
          {advCount > 0 && (
            <button
              className="btn mini adv-reset"
              onClick={() => onAdvChange({ sub: '', country: '', network: '', security: '' })}
            >
              حذف فیلترها
            </button>
          )}
        </div>
      )}
    </>
  );
}
