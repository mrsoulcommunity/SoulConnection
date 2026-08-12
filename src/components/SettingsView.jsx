import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes } from '../utils/format.js';
import {
  Section, Toggle, SelectField, SettingsFilterProvider,
} from './settingsPrimitives.jsx';
import NetworkSettings from './NetworkSettings.jsx';
import FailoverSettings from './FailoverSettings.jsx';
import UpdatePanel from './UpdatePanel.jsx';
import ShieldPanel from './ShieldPanel.jsx';
import { ConfirmModal } from './ManageModals.jsx';

const INTERVAL_OPTIONS = [
  { value: 0, label: 'خاموش' },
  { value: 6 * 3600000, label: 'هر ۶ ساعت' },
  { value: 12 * 3600000, label: 'هر ۱۲ ساعت' },
  { value: 24 * 3600000, label: 'هر ۲۴ ساعت' },
];

const LOG_LEVELS = [
  { value: 'warning', label: 'هشدار (پیش‌فرض)' },
  { value: 'info', label: 'اطلاعات' },
  { value: 'debug', label: 'دیباگ' },
];

const RECONNECT_ATTEMPTS = [
  { value: 3, label: '۳ بار' },
  { value: 5, label: '۵ بار (پیش‌فرض)' },
  { value: 10, label: '۱۰ بار' },
  { value: 20, label: '۲۰ بار' },
];

const RECONNECT_DELAYS = [
  { value: 1000, label: 'سریع — ۱ ثانیه' },
  { value: 2000, label: 'متعادل — ۲ ثانیه (پیش‌فرض)' },
  { value: 5000, label: 'صبور — ۵ ثانیه' },
];

// The search box sits above everything and filters whole cards. Kept in the
// header rather than inside the scroller so it stays reachable at any scroll
// position -- a filter you have to scroll back up to reach is a filter nobody
// uses twice.
function SettingsSearch({ query, onChange, hits, total }) {
  return (
    <div className="settings-search">
      <span className="settings-search-icon" aria-hidden="true"><Icon name="search" size={14} /></span>
      <input
        className="settings-search-input"
        type="search"
        value={query}
        placeholder="جست‌وجو در تنظیمات… (مثلاً: پورت، اعلان، DNS)"
        onChange={(e) => onChange(e.target.value)}
        aria-label="جست‌وجو در تنظیمات"
      />
      {query && (
        <>
          <span className={`settings-search-count ${hits ? '' : 'none'}`}>
            {hits ? `${hits} از ${total} بخش` : 'چیزی پیدا نشد'}
          </span>
          <button className="icon-btn ghost settings-search-clear" title="پاک کردن" onClick={() => onChange('')}>
            <Icon name="close" size={13} />
          </button>
        </>
      )}
    </div>
  );
}

export default function SettingsView({
  settings, connectionState, profiles, appInfo, systemProxy,
  updaterStatus, onCheckForUpdates, onDownloadUpdate, onDownloadAndInstall, onInstallUpdate,
  onCancelUpdateDownload, onCancelAutoInstall, onOpenUpdateFolder,
  shield, shieldProgress, onShieldTune, onShieldCancel, onShieldClear, onShieldManualKey,
  onUpdate, onUpdateChecked, onOpenLogsFolder,
  onExportBackup, onImportBackup, onResetUsage, onResetAllUsage,
  onSystemProxySetDesired, onSystemProxySync, onOpenProxyFolder, onResetNetworkDefaults,
  onResetAllSettings,
  killSwitchBlocking, health, failover,
}) {
  const portsLocked = connectionState !== 'disconnected';
  const [query, setQuery] = useState('');
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const totalUsage = (profiles || []).reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const usedProfiles = useMemo(
    () => (profiles || []).filter((p) => p.totalBytes > 0),
    [profiles]
  );

  // Counted from the DOM after the cards have filtered themselves, so the
  // readout can never disagree with what is actually on screen. Deliberately
  // not a remount-on-query (a `key`) -- that would throw away the tab, draft
  // and log-feed state living inside the cards on every keystroke.
  const cardsRef = useRef(null);
  const [counts, setCounts] = useState({ hits: 0, total: 0 });
  useEffect(() => {
    const node = cardsRef.current;
    if (!node) return;
    const cards = node.querySelectorAll('.settings-card');
    const hits = [...cards].filter((c) => !c.hidden).length;
    setCounts((prev) => (prev.hits === hits && prev.total === cards.length
      ? prev : { hits, total: cards.length }));
  });

  return (
    <div className="settings-view">
      <SettingsSearch
        query={query}
        onChange={setQuery}
        hits={counts.hits}
        total={counts.total}
      />

      <SettingsFilterProvider query={query}>
        <div className="settings-cards" ref={cardsRef}>
          <Section title="اتصال" icon="bolt" description="رفتار برنامه هنگام اجرا و اتصال">
            <Toggle
              label="اجرای خودکار با ویندوز"
              hint="Soul Connection هنگام ورود به ویندوز خودکار اجرا می‌شود"
              checked={settings.launchOnStartup}
              onChange={(v) => onUpdate({ launchOnStartup: v })}
            />
            <Toggle
              label="اجرای پروکسی محلی هنگام شروع"
              hint="به آخرین سرور فعال، خودکار وصل می‌شود؛ پروکسی سیستم را خودکار روشن نمی‌کند"
              checked={settings.runLocalProxyOnStartup}
              onChange={(v) => onUpdate({ runLocalProxyOnStartup: v })}
            />
            <Toggle
              label="شروع به‌صورت کوچک‌شده"
              hint="پنجره هنگام اجرا نمایش داده نمی‌شود"
              checked={settings.startMinimized}
              onChange={(v) => onUpdate({ startMinimized: v })}
            />
            <Toggle
              label="کوچک‌شدن به Tray"
              hint="با بستن پنجره، برنامه به‌جای خروج، مخفی می‌شود"
              checked={settings.minimizeToTray}
              onChange={(v) => onUpdate({ minimizeToTray: v })}
            />
            <Toggle
              label="بازیابی نشست قبلی"
              hint="آخرین تب، جست‌وجو، مرتب‌سازی و گروه‌های بازشده به همان حالت قبل برمی‌گردند"
              checked={settings.restorePreviousSession}
              onChange={(v) => onUpdate({ restorePreviousSession: v })}
            />
          </Section>

          <Section title="اتصال مجدد خودکار" icon="refresh" description="رفتار برنامه وقتی تونل ناخواسته قطع می‌شود">
            <Toggle
              label="اتصال مجدد خودکار"
              hint="در صورت قطعی ناخواسته‌ی تونل، خودکار تلاش برای وصل‌شدن دوباره"
              checked={settings.autoReconnect}
              onChange={(v) => onUpdate({ autoReconnect: v })}
            />
            <SelectField
              label="تعداد تلاش"
              hint="بعد از این تعداد تلاش ناموفق، برنامه دست می‌کشد و خبر می‌دهد"
              value={settings.reconnectAttempts ?? 5}
              options={RECONNECT_ATTEMPTS}
              disabled={!settings.autoReconnect}
              onChange={(v) => onUpdate({ reconnectAttempts: Number(v) })}
            />
            <SelectField
              label="فاصله‌ی بین تلاش‌ها"
              hint="هر تلاش کمی بیشتر از قبلی صبر می‌کند؛ این عدد گام آن است"
              value={settings.reconnectDelayMs ?? 2000}
              options={RECONNECT_DELAYS}
              disabled={!settings.autoReconnect}
              onChange={(v) => onUpdate({ reconnectDelayMs: Number(v) })}
            />
          </Section>

          <Section title="اعلان‌ها" icon="info" description="کدام رویدادها روی ویندوز اعلان نشان بدهند">
            <Toggle
              label="نمایش اعلان‌ها"
              hint="با خاموش‌کردن این گزینه، هیچ اعلانی از برنامه نمایش داده نمی‌شود"
              checked={settings.notifications !== false}
              onChange={(v) => onUpdate({ notifications: v })}
            />
            <Toggle
              label="وصل و قطع شدن"
              hint="اتصال موفق، قطعی ناخواسته و تلاش‌های اتصال مجدد"
              checked={settings.notifyConnection !== false}
              onChange={(v) => onUpdate({ notifyConnection: v })}
            />
            <Toggle
              label="تعویض خودکار سرور"
              hint="وقتی سیستم جابه‌جایی خودکار، سرور را عوض می‌کند"
              checked={settings.notifyFailover !== false}
              onChange={(v) => onUpdate({ notifyFailover: v })}
            />
            <Toggle
              label="به‌روزرسانی‌ها"
              hint="انتشار نسخه‌ی جدید و به‌روزرسانی ساب‌اسکریپشن‌ها"
              checked={settings.notifyUpdates !== false}
              onChange={(v) => onUpdate({ notifyUpdates: v })}
            />
            {settings.notifications === false && (
              <p className="setting-hint settings-note">
                هشدارهای مهم (مثل ناموفق‌بودن Kill Switch) هم نمایش داده نمی‌شوند.
              </p>
            )}
          </Section>

          <Section title="ساب‌اسکریپشن" icon="refresh" description="به‌روزرسانی خودکار">
            <SelectField
              label="به‌روزرسانی خودکار ساب‌اسکریپشن‌ها"
              hint="فهرست سرورها در این فاصله‌ها خودکار از منبع تازه گرفته می‌شود"
              value={settings.subAutoUpdateInterval}
              options={INTERVAL_OPTIONS}
              onChange={(v) => onUpdate({ subAutoUpdateInterval: Number(v) })}
            />
          </Section>

          <NetworkSettings
            settings={settings}
            connectionState={connectionState}
            systemProxy={systemProxy}
            killSwitchBlocking={killSwitchBlocking}
            onUpdate={onUpdate}
            onUpdateChecked={onUpdateChecked}
            onSystemProxySetDesired={onSystemProxySetDesired}
            onSystemProxySync={onSystemProxySync}
            onOpenProxyFolder={onOpenProxyFolder}
            onResetNetworkDefaults={onResetNetworkDefaults}
          />

          <FailoverSettings
            settings={settings}
            health={health}
            failover={failover}
            onUpdate={onUpdate}
          />

          <Section title="مصرف داده" icon="database" description="میزان ترافیک مصرفی هر سرور">
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">مجموع مصرف همه‌ی سرورها</span>
                <span className="setting-hint mono" dir="ltr">{formatBytes(totalUsage)}</span>
              </div>
              <button
                className="btn icon-inline-btn"
                onClick={onResetAllUsage}
                disabled={!totalUsage}
              >
                <Icon name="trash" size={14} />
                پاک کردن
              </button>
            </div>
            {usedProfiles.length === 0 && (
              <p className="setting-hint settings-note">
                هنوز از هیچ سروری ترافیکی عبور نکرده است.
              </p>
            )}
            {usedProfiles.map((p) => (
              <div className="setting-row" key={p.id}>
                <div className="setting-text">
                  <span className="setting-label">{p.name || p.address}</span>
                  <span className="setting-hint mono" dir="ltr">{formatBytes(p.totalBytes)}</span>
                </div>
                <button className="icon-btn" title="ریست این سرور" onClick={() => onResetUsage(p.id)}>
                  <Icon name="refresh" size={14} />
                </button>
              </div>
            ))}
          </Section>

          <Section title="پشتیبان‌گیری" icon="shield" description="ذخیره و بازیابی کانفیگ‌ها و تنظیمات">
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">خروجی گرفتن از کانفیگ‌ها</span>
                <span className="setting-hint">همه‌ی سرورها، ساب‌اسکریپشن‌ها و تنظیمات را در یک فایل JSON ذخیره کن</span>
              </div>
              <button className="btn icon-inline-btn" onClick={onExportBackup}>
                <Icon name="arrowDown" size={14} />
                خروجی
              </button>
            </div>
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">بازیابی از فایل پشتیبان</span>
                <span className="setting-hint error">کانفیگ‌های فعلی جایگزین می‌شوند</span>
              </div>
              <button className="btn icon-inline-btn" onClick={onImportBackup} disabled={portsLocked}>
                <Icon name="arrowUp" size={14} />
                بازیابی
              </button>
            </div>
          </Section>

          <Section title="لاگ و عیب‌یابی" icon="sliders" description="سطح جزئیات لاگ Xray و محل فایل‌ها">
            <SelectField
              label="سطح لاگ Xray"
              hint="هرچه جزئی‌تر، فایل لاگ سنگین‌تر؛ برای عیب‌یابی «دیباگ» را موقت روشن کن"
              value={settings.xrayLogLevel}
              options={LOG_LEVELS}
              onChange={(v) => onUpdate({ xrayLogLevel: v })}
            />
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">پوشه‌ی لاگ‌ها و کانفیگ فعال</span>
              </div>
              <button className="btn icon-inline-btn" onClick={onOpenLogsFolder}>
                <Icon name="folder" size={14} />
                باز کردن
              </button>
            </div>
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">بازگرداندن همه‌ی تنظیمات به پیش‌فرض</span>
                <span className="setting-hint error">
                  همه‌ی تنظیمات این صفحه به حالت اولیه برمی‌گردند. سرورها، ساب‌اسکریپشن‌ها و قوانین مسیریابی دست‌نخورده می‌مانند.
                </span>
              </div>
              <button
                className="btn icon-inline-btn danger"
                disabled={portsLocked}
                onClick={() => setConfirmResetAll(true)}
              >
                <Icon name="refresh" size={14} />
                بازنشانی
              </button>
            </div>
            {portsLocked && (
              <p className="setting-hint settings-note">برای بازنشانی، اول قطع اتصال کن.</p>
            )}
          </Section>

          <ShieldPanel
            shield={shield}
            mode={settings.shieldMode || 'auto'}
            progress={shieldProgress}
            onTune={onShieldTune}
            onCancel={onShieldCancel}
            onClear={onShieldClear}
            onModeChange={(v) => onUpdate({ shieldMode: v })}
            onManualKeyChange={onShieldManualKey}
          />

          <UpdatePanel
            appInfo={appInfo}
            update={updaterStatus}
            mode={settings.autoUpdateMode || 'auto'}
            onCheck={onCheckForUpdates}
            onDownload={onDownloadUpdate}
            onDownloadAndInstall={onDownloadAndInstall}
            onInstallNow={onInstallUpdate}
            onCancelDownload={onCancelUpdateDownload}
            onCancelAuto={onCancelAutoInstall}
            onOpenFolder={onOpenUpdateFolder}
            onModeChange={(v) => onUpdate({ autoUpdateMode: v })}
          />
        </div>
      </SettingsFilterProvider>

      {confirmResetAll && (
        <ConfirmModal
          title="بازگرداندن تنظیمات به پیش‌فرض"
          message="همه‌ی تنظیمات برنامه (اتصال، شبکه، اعلان‌ها، Kill Switch، جابه‌جایی خودکار و بقیه) به حالت اولیه برمی‌گردند. سرورها، ساب‌اسکریپشن‌ها، قوانین مسیریابی و آمار مصرف حذف نمی‌شوند. ادامه می‌دهی؟"
          confirmLabel="بازنشانی"
          onClose={() => setConfirmResetAll(false)}
          onConfirm={onResetAllSettings}
        />
      )}
    </div>
  );
}
