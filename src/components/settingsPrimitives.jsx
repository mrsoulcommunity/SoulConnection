import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Shared building blocks for the Settings screens (SettingsView.jsx,
// NetworkSettings.jsx) -- kept in one file so the two sibling views don't
// need to import from each other.

// ---- Search ----
//
// Settings is fifteen cards and five screens of scrolling, which is fine to
// read once and hopeless to navigate afterwards: finding "the DNS one" meant
// scrolling past everything else looking for it.
//
// The filter is a context rather than a prop threaded through every component,
// because the cards are spread across four files and none of them should have
// to know a search box exists. A Section matches when the query appears
// anywhere in the text it renders -- title, description, labels, hints -- which
// is what someone typing "kill" or "پورت" actually means, and it keeps working
// for cards added later without anyone maintaining a keyword list.
const SettingsFilterContext = createContext('');

export function SettingsFilterProvider({ query, children }) {
  return (
    <SettingsFilterContext.Provider value={query || ''}>
      {children}
    </SettingsFilterContext.Provider>
  );
}

// Arabic/Persian letters have several Unicode spellings that look identical;
// a user typing ي or ك on an Arabic keyboard must still find a label written
// with ی or ک. Digits are folded the same way so "10808" finds "۱۰۸۰۸".
const AR_FA = { 'ي': 'ی', 'ك': 'ک', 'ۀ': 'ه', 'ة': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا' };
const DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

export function normalizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[يكۀةأإآ]/g, (c) => AR_FA[c] || c)
    .replace(/[۰-۹]/g, (c) => DIGITS[c] || c)
    .replace(/[‌‏‎]/g, ' ') // ZWNJ and the bidi marks are invisible; treat them as spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// What a card can be found by. `textContent` alone misses the thing people
// most often search a settings screen for -- the value in the box, like the
// port number they are trying to locate -- so field values and placeholders
// count too. Passwords never do: a secret must not become discoverable by
// typing it into an unrelated search box.
function searchableText(node) {
  if (!node) return '';
  const parts = [node.textContent];
  for (const el of node.querySelectorAll('input, textarea')) {
    if (el.type === 'password') continue;
    parts.push(el.value, el.placeholder);
  }
  return parts.filter(Boolean).join(' ');
}

export function Section({ title, icon, description, children }) {
  const query = normalizeSearch(useContext(SettingsFilterContext));
  const ref = useRef(null);
  const [hidden, setHidden] = useState(false);

  // Reads the card's own rendered text, so nothing has to declare keywords and
  // a card can never fall out of the index by being forgotten. Layout effect
  // rather than effect: the card must not flash before being hidden.
  useLayoutEffect(() => {
    if (!query) { setHidden(false); return; }
    setHidden(!normalizeSearch(searchableText(ref.current)).includes(query));
  });

  return (
    <section className="settings-card" ref={ref} hidden={hidden || undefined}>
      <header className="settings-card-head">
        <span className="settings-card-icon"><Icon name={icon} size={16} /></span>
        <div className="settings-card-heading">
          <h2 className="settings-section-title">{title}</h2>
          {description && <p className="settings-card-desc">{description}</p>}
        </div>
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

// The row used to be a <label> wrapping a <button role="switch">, which looks
// right and is wrong twice over: a <label> only names real form controls, so
// the switch announced itself as an unnamed "switch, off", and a <label> only
// forwards clicks to a real form control, so the whole wide row -- the obvious
// thing to click -- was dead and the 40px switch was the only target. Naming
// the button from the label's own id fixes the first; making the row a plain
// clickable div fixes the second, without either of them needing a hidden
// checkbox and a second set of CSS states.
export function Toggle({ checked, onChange, label, hint, disabled }) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div
      className={`setting-row toggle-row ${disabled ? 'disabled' : ''}`.trim()}
      onClick={(e) => {
        // The switch handles its own click; anywhere else in the row counts.
        if (disabled || e.target.closest('.switch')) return;
        onChange(!checked);
      }}
    >
      <div className="setting-text">
        <span className="setting-label" id={labelId}>{label}</span>
        {hint && <span className="setting-hint" id={hintId}>{hint}</span>}
      </div>
      <button
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        type="button"
      >
        <span className="knob" />
      </button>
    </div>
  );
}

// A labelled dropdown. The same row markup was being written out by hand at
// every call site, which is how two of them ended up without a hint and one
// without a disabled state.
export function SelectField({ label, hint, value, options, onChange, disabled }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="setting-row">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>{label}</label>
        {hint && <span className="setting-hint" id={hintId}>{hint}</span>}
      </div>
      <select
        className="setting-select"
        id={id}
        aria-describedby={hint ? hintId : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// Mirrors its own draft while typing, but always re-syncs to the real,
// backend-confirmed value once a commit attempt settles -- whether it
// succeeded or was rejected (e.g. SOCKS/HTTP port collision) -- so the field
// never keeps showing a value that was never actually applied.
export function PortField({ label, value, onCommit, disabled }) {
  const id = useId();
  const errId = `${id}-err`;
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');

  useEffect(() => { setDraft(String(value)); }, [value]);

  async function commit() {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError('بین ۱۰۲۴ تا ۶۵۵۳۵');
      setDraft(String(value));
      return;
    }
    setError('');
    if (n === value) return;
    try {
      await onCommit(n);
    } catch (err) {
      setDraft(String(value));
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>{label}</label>
        {/* role="alert" because the error appears after the field has already
            lost focus -- nothing else on the screen would ever announce it. */}
        {error && <span className="setting-hint error" id={errId} role="alert">{error}</span>}
      </div>
      <input
        className="setting-select port-input mono"
        id={id}
        type="number"
        min={1024}
        max={65535}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

export function BypassField({ value, onCommit }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    if (draft === (value || '')) return;
    setSaving(true);
    try {
      await onCommit(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="setting-row column">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>لیست bypass سفارشی</label>
        <span className="setting-hint" id={hintId}>آدرس‌ها یا الگوهایی که باید همیشه مستقیم (بدون پروکسی) باز شوند؛ با ; یا خط جدید جدا کن. مثال: example.com;10.20.*</span>
      </div>
      <textarea
        className="mono bypass-textarea"
        id={id}
        aria-describedby={hintId}
        value={draft}
        placeholder="example.com;*.internal.local"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        disabled={saving}
      />
    </div>
  );
}

// Renderer-side mirror of the same validation electron/main.cjs applies --
// fails fast in the UI instead of round-tripping to the main process first.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export function isValidHost(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const m = v.match(IPV4_RE);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME_RE.test(v);
}

// Generic single-line text field with the same draft/commit/error shape as
// PortField, reused for Host and Username inputs.
export function TextField({ label, value, onCommit, disabled, placeholder, hint, validate }) {
  const id = useId();
  const noteId = `${id}-note`;
  const [draft, setDraft] = useState(value || '');
  const [error, setError] = useState('');

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    const v = draft.trim();
    if (validate) {
      const msg = validate(v);
      if (msg) {
        setError(msg);
        setDraft(value || '');
        return;
      }
    }
    setError('');
    if (v === (value || '')) return;
    try {
      await onCommit(v);
    } catch (err) {
      setDraft(value || '');
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>{label}</label>
        {error
          ? <span className="setting-hint error" id={noteId} role="alert">{error}</span>
          : hint ? <span className="setting-hint" id={noteId}>{hint}</span> : null}
      </div>
      <input
        className="setting-select mono"
        id={id}
        type="text"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

// Same shape as TextField, plus a show/hide toggle. Optional field -- an
// empty value is always valid (no username/password required).
export function PasswordField({ label, value, onCommit, disabled, hint }) {
  const id = useId();
  const noteId = `${id}-note`;
  const [draft, setDraft] = useState(value || '');
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    setError('');
    if (draft === (value || '')) return;
    try {
      await onCommit(draft);
    } catch (err) {
      setDraft(value || '');
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>{label}</label>
        {error
          ? <span className="setting-hint error" id={noteId} role="alert">{error}</span>
          : hint ? <span className="setting-hint" id={noteId}>{hint}</span> : null}
      </div>
      <div className="password-field-wrap">
        <input
          className="setting-select mono"
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? noteId : undefined}
          value={draft}
          disabled={disabled}
          placeholder="—"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        {/* Was tabIndex={-1}, which excluded exactly the people who cannot
            fall back to "just look at the dots": someone typing a proxy
            password without a mouse had no way to check what they typed. It
            is a real control, so it takes a real tab stop and reports state. */}
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? 'پنهان کردن رمز' : 'نمایش رمز'}
          title={visible ? 'پنهان کردن رمز' : 'نمایش رمز'}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={13} />
        </button>
      </div>
    </div>
  );
}
