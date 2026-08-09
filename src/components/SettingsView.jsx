import React from 'react';
import Icon from './Icon.jsx';
import { formatBytes } from '../utils/format.js';
import { Section, Toggle } from './settingsPrimitives.jsx';
import NetworkSettings from './NetworkSettings.jsx';
import FailoverSettings from './FailoverSettings.jsx';
import UpdatePanel from './UpdatePanel.jsx';

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

export default function SettingsView({
  settings, connectionState, profiles, appInfo, systemProxy,
  updaterStatus, onCheckForUpdates, onDownloadUpdate, onDownloadAndInstall, onInstallUpdate,
  onCancelUpdateDownload, onCancelAutoInstall, onOpenUpdateFolder,
  onUpdate, onUpdateChecked, onOpenLogsFolder,
  onExportBackup, onImportBackup, onResetUsage, onResetAllUsage,
  onSystemProxySetDesired, onSystemProxySync, onOpenProxyFolder, onResetNetworkDefaults,
  killSwitchBlocking, health, failover,
}) {
  const portsLocked = connectionState !== 'disconnected';
  const totalUsage = (profiles || []).reduce((sum, p) => sum + (p.totalBytes || 0), 0);

  return (
    <div className="settings-view">
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
          label="اتصال مجدد خودکار"
          hint="در صورت قطعی ناخواسته‌ی تونل، خودکار تلاش برای وصل‌شدن دوباره"
          checked={settings.autoReconnect}
          onChange={(v) => onUpdate({ autoReconnect: v })}
        />
        <Toggle
          label="بازیابی نشست قبلی"
          hint="آخرین تب، جست‌وجو، مرتب‌سازی و گروه‌های بازشده به همان حالت قبل برمی‌گردند"
          checked={settings.restorePreviousSession}
          onChange={(v) => onUpdate({ restorePreviousSession: v })}
        />
      </Section>

      <Section title="ساب‌اسکریپشن" icon="refresh" description="به‌روزرسانی خودکار">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">به‌روزرسانی خودکار ساب‌اسکریپشن‌ها</span>
          </div>
          <select
            className="setting-select"
            value={settings.subAutoUpdateInterval}
            onChange={(e) => onUpdate({ subAutoUpdateInterval: Number(e.target.value) })}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
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
            <span className="setting-hint mono">{formatBytes(totalUsage)}</span>
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
        {(profiles || []).filter((p) => p.totalBytes > 0).map((p) => (
          <div className="setting-row" key={p.id}>
            <div className="setting-text">
              <span className="setting-label">{p.name || p.address}</span>
              <span className="setting-hint mono">{formatBytes(p.totalBytes)}</span>
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

      <Section title="پیشرفته" icon="sliders" description="لاگ‌ها و تنظیمات فنی Xray">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">سطح لاگ Xray</span>
          </div>
          <select
            className="setting-select"
            value={settings.xrayLogLevel}
            onChange={(e) => onUpdate({ xrayLogLevel: e.target.value })}
          >
            {LOG_LEVELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">پوشه‌ی لاگ‌ها و کانفیگ فعال</span>
          </div>
          <button className="btn icon-inline-btn" onClick={onOpenLogsFolder}>
            <Icon name="folder" size={14} />
            باز کردن
          </button>
        </div>
      </Section>

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
  );
}
