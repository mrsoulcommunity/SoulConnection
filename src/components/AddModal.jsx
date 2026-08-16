import React, { useState } from 'react';
import CustomConfigForm from './CustomConfigForm.jsx';
import ModalShell from './ModalShell.jsx';

export default function AddModal({ onClose, onAddLink, onAddSubscription, onAddCustom }) {
  const [tab, setTab] = useState('link');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!value.trim()) return;
    setError('');
    setLoading(true);
    try {
      if (tab === 'link') {
        await onAddLink(value.trim());
      } else {
        await onAddSubscription(value.trim());
      }
    } catch (err) {
      setError(err.message || 'خطا رخ داد');
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalShell label="افزودن کانفیگ" onClose={onClose} className={tab === 'custom' ? 'wide' : ''}>
      <h3>افزودن کانفیگ</h3>
      <p className="hint">
        {tab === 'custom'
          ? 'تمام تنظیمات کانفیگ را به‌صورت دستی وارد کن.'
          : 'یک یا چند لینک vmess://, vless://, trojan:// یا ss:// (پشت‌سرهم یا در چند خط) یا یک آدرس ساب‌اسکریپشن وارد کن.'}
      </p>

      <div className="tabs" role="tablist">
        <button
          className={`tab ${tab === 'link' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'link'}
          onClick={() => setTab('link')}
        >
          لینک
        </button>
        <button
          className={`tab ${tab === 'sub' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'sub'}
          onClick={() => setTab('sub')}
        >
          ساب‌اسکریپشن
        </button>
        <button
          className={`tab ${tab === 'custom' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'custom'}
          onClick={() => setTab('custom')}
        >
          دستی
        </button>
      </div>

      {tab === 'custom' ? (
        <CustomConfigForm onSubmit={onAddCustom} onCancel={onClose} />
      ) : (
        <>
          {tab === 'link' ? (
            <textarea
              className="mono"
              placeholder="vmess://..."
              aria-label="لینک کانفیگ"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          ) : (
            <input
              className="mono"
              placeholder="https://example.com/sub"
              aria-label="آدرس ساب‌اسکریپشن"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          )}

          {error && <div className="error-msg" role="alert">{error}</div>}

          <div className="row">
            <button className="btn" onClick={onClose}>انصراف</button>
            <button className="btn primary" onClick={handleSubmit} disabled={loading || !value.trim()}>
              {loading ? 'در حال افزودن…' : 'افزودن'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
