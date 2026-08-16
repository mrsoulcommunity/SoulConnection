import React, { useEffect, useState, useCallback, useMemo } from 'react';
import TitleBar from './components/TitleBar.jsx';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import StatusBar from './components/StatusBar.jsx';
import SettingsView from './components/SettingsView.jsx';
import ServerFinder from './components/finder/ServerFinder.jsx';
import SoulPoolEntry from './components/SoulPoolEntry.jsx';
import RoutingRules from './components/RoutingRules.jsx';
import { FailoverStatus } from './components/FailoverSettings.jsx';
import TunnelStatus from './components/TunnelStatus.jsx';
import UpdateCard from './components/UpdateCard.jsx';
import Icon from './components/Icon.jsx';
import { pingMs } from './utils/ping.js';
import useToast from './hooks/useToast.js';
import useMainState from './hooks/useMainState.js';
import useSessionPersistence from './hooks/useSessionPersistence.js';
import useConnection from './hooks/useConnection.js';
import useLibrary from './hooks/useLibrary.js';
import useRoutingActions from './hooks/useRoutingActions.js';
import useSettingsActions from './hooks/useSettingsActions.js';
import useSystemProxyActions from './hooks/useSystemProxyActions.js';
import useShieldActions from './hooks/useShieldActions.js';
import usePings from './hooks/usePings.js';
import useUpdateOffer, { downloadAndInstall, installUpdate, cancelUpdateDownload, cancelAutoInstall } from './hooks/useUpdateOffer.js';
import useGlobalShortcuts from './hooks/useGlobalShortcuts.js';
import useWindowChrome from './hooks/useWindowChrome.js';
import useReducedMotion from './hooks/useReducedMotion.js';

// ---- The renderer's composition root ----
//
// App builds nothing and decides nothing on its own; it plays the role for
// the renderer that vpn/index.cjs plays for the VPN core. All state that
// mirrors the main process lives in useMainState; every user action lives in
// a domain hook that owns one concern (connection, library, routing, ...) and
// writes main's answers back through useMainState's `set` bundle. What is
// left here is exactly the composition: wiring hooks to each other and to the
// presentational components, plus the handful of derivations (`heroTarget`)
// that exist only to be rendered.
//
// Components stay presentational and take callbacks; nothing below App
// subscribes to IPC except the two module stores (telemetryStore for the 1s
// telemetry ticks, finder/testEngine for test batches), which exist so their
// high-frequency updates reach only the components that display them.
export default function App() {
  const { toast, showToast } = useToast();
  const main = useMainState();
  const {
    profiles, subscriptions, activeProfileId, connectionMode, connectionState,
    connectedAt, settings, appInfo, updaterStatus, shield, shieldProgress,
    soulMode, soulCount, soulProgress, activeSoulProfile, systemProxy,
    killSwitchBlocking, routing, routingNeedsReconnect, health, failover,
    failoverEvent,
  } = main;

  const { tab, setTab, sessionRef, handleSessionChange } = useSessionPersistence(settings);
  const connection = useConnection(main, showToast);
  const library = useLibrary(main, showToast);
  const routingActions = useRoutingActions(main, showToast);
  const settingsActions = useSettingsActions(main, showToast);
  const systemProxyActions = useSystemProxyActions(main, showToast);
  const shieldActions = useShieldActions(main, showToast);
  const pinger = usePings();
  const { updateOffered, handleDismissUpdate } = useUpdateOffer(updaterStatus);
  const chrome = useWindowChrome();
  useReducedMotion(settings?.reduceMotion);

  const [finderOpen, setFinderOpen] = useState(false);
  useGlobalShortcuts({
    finderOpen,
    setFinderOpen,
    onAddLink: library.handleAddLink,
    onAddSubscription: library.handleAddSubscription,
    showToast,
  });

  // The tray's "open settings" item -- a navigation event, not state, so it
  // lands here where the tab lives rather than inside the state mirror.
  useEffect(() => {
    const off = window.soul.onOpenSettings(() => setTab('settings'));
    return () => off();
  }, [setTab]);

  const handleDismissFailover = useCallback(() => main.set.setFailoverEvent(null), [main.set]);

  // A pool server isn't in `profiles`, so fall back to the copy main ships
  // with the state payload -- otherwise the hero would claim no server is
  // selected while the tunnel is up on a pool server.
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId)
      || (activeSoulProfile && activeSoulProfile.id === activeProfileId ? activeSoulProfile : undefined),
    [profiles, activeProfileId, activeSoulProfile]
  );

  // What pressing connect would actually reach. Not always a profile: the Soul
  // pool and "choose the best for me" are real selections with no
  // `activeProfileId` behind them, and reading `activeProfile` alone is how the
  // hero came to claim no server was selected while the sidebar showed one.
  const heroTarget = useMemo(() => {
    if (activeProfile) {
      return {
        name: activeProfile.name || activeProfile.address,
        detail: `${activeProfile.address}:${activeProfile.port}`,
        mono: true,
      };
    }
    if (soulMode) {
      return {
        name: 'سرورهای سول کانکشن',
        detail: soulCount ? `${soulCount} سرور — انتخاب خودکار بهترین` : 'انتخاب خودکار بهترین',
      };
    }
    if (settings?.autoSelectBestServer && profiles.length > 0) {
      return { name: 'انتخاب خودکار بهترین سرور', detail: `از میان ${profiles.length} کانفیگ` };
    }
    return null;
  }, [activeProfile, soulMode, soulCount, settings?.autoSelectBestServer, profiles.length]);

  return (
    <div className={`app-shell ${chrome.windowMaximized ? 'maximized' : ''}`}>
      <TitleBar
        maximized={chrome.windowMaximized}
        onMinimize={chrome.minimize}
        onToggleMaximize={chrome.toggleMaximize}
        onClose={chrome.close}
      />
      <div className="workspace">
        <aside className="sidebar">
          <header className="sidebar-head">
            <img className="mark" src="./icon.png" alt="" />
            <div className="brand">
              <span className="brand-name">Soul Connection</span>
              <span className="brand-sub">
                {profiles.length ? `${profiles.length} کانفیگ` : 'کلاینت V2Ray / Xray'}
              </span>
            </div>
          </header>

          <SoulPoolEntry
            enabled={soulMode}
            count={soulCount}
            connectionState={connectionState}
            progress={soulProgress}
            activeSoulProfile={activeSoulProfile}
            busy={connection.busy && !connection.soulCancelable}
            refreshing={connection.soulRefreshing}
            cancelable={connection.soulCancelable}
            onSelect={connection.handleSoulSelect}
            onRefresh={connection.handleSoulRefresh}
          />

          <ServerList
            profiles={profiles}
            subscriptions={subscriptions}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            pings={pinger.pings}
            updatingSubs={library.updatingSubs}
            refreshingSubIds={library.refreshingSubIds}
            onSelect={connection.handleSelect}
            onDelete={library.handleDelete}
            onPing={pinger.handlePing}
            onPingAll={pinger.handlePingAll}
            pingSweep={pinger.pingSweep}
            onCancelPingAll={pinger.handleCancelPingAll}
            onDismissPingSweep={pinger.handleDismissPingSweep}
            onAdd={library.openAdd}
            onRefreshSubscription={library.handleRefreshSubscription}
            onUpdateAllSubscriptions={library.handleUpdateAllSubscriptions}
            onDeleteSubscription={library.handleDeleteSubscription}
            onConnectTo={connection.handleConnectTo}
            onDisconnect={connection.handleDisconnect}
            onRenameProfile={library.handleRenameProfile}
            onEditProfile={library.handleEditProfile}
            onUpdateSubscription={library.handleUpdateSubscription}
            onToast={showToast}
            initialQuery={sessionRef.current.query}
            initialSortBy={sessionRef.current.sortBy}
            initialCollapsed={sessionRef.current.collapsed}
            onSessionChange={handleSessionChange}
          />

          {updateOffered && (
            <UpdateCard
              update={updaterStatus}
              onDownload={downloadAndInstall}
              onInstall={installUpdate}
              onCancelDownload={cancelUpdateDownload}
              onCancelAuto={cancelAutoInstall}
              onDismiss={handleDismissUpdate}
            />
          )}

          {profiles.length > 0 && (
            <footer className="sidebar-foot">
              <button className="btn primary add-btn" onClick={library.openAdd}>
                <Icon name="plus" size={15} />
                افزودن کانفیگ
              </button>
              <button
                className="icon-btn tall"
                onClick={() => setFinderOpen(true)}
                title="سرور یاب هوشمند (Ctrl+K)"
              >
                <Icon name="radar" size={15} />
              </button>
            </footer>
          )}
        </aside>

        <main className="main">
          <header className="main-head">
            <span className="main-title">
              {tab === 'settings' ? 'تنظیمات' : tab === 'routing' ? 'قوانین مسیریابی' : 'کنترل اتصال'}
            </span>
            <div className="main-head-actions">
              <button
                className={`icon-btn ghost ${tab === 'routing' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'routing' ? 'servers' : 'routing')}
                title={tab === 'routing' ? 'بازگشت به کنترل اتصال' : 'قوانین مسیریابی'}
              >
                <Icon name={tab === 'routing' ? 'close' : 'filter'} size={16} />
              </button>
              <button
                className={`icon-btn ghost ${tab === 'settings' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'settings' ? 'servers' : 'settings')}
                title={tab === 'settings' ? 'بازگشت به کنترل اتصال' : 'تنظیمات'}
              >
                <Icon name={tab === 'settings' ? 'close' : 'settings'} size={16} />
              </button>
            </div>
          </header>

          {tab === 'servers' ? (
            <>
              <ConnectHero
                phase={connection.heroPhase}
                connectionMode={connectionMode}
                target={heroTarget}
                onToggle={connection.handleToggleConnect}
                onSetMode={connection.handleSetMode}
              />
              {/* Sits between the hero and the metrics rail: the hero is the
                  action, this is the proof it worked, the rail is the running
                  telemetry. It renders nothing at all while disconnected, so
                  the idle screen stays exactly as it was. */}
              <TunnelStatus
                connectionState={connectionState}
                activeProfile={activeProfile}
                systemProxy={systemProxy}
                onToast={showToast}
              />
            </>
          ) : tab === 'routing' ? (
            <div className="settings-pane">
              <RoutingRules
                routing={routing}
                connectionState={connectionState}
                connectionMode={connectionMode}
                needsReconnect={routingNeedsReconnect}
                onSetMode={routingActions.handleSetRoutingMode}
                onSetLanDirect={routingActions.handleSetLanDirect}
                onSaveRule={routingActions.handleSaveRule}
                onDeleteRule={routingActions.handleDeleteRule}
                onToggleRule={routingActions.handleToggleRule}
                onAddDomains={routingActions.handleAddDomains}
                onReconnect={connection.handleReconnect}
              />
            </div>
          ) : (
            <div className="settings-pane">
              {settings && (
                <SettingsView
                  settings={settings}
                  connectionState={connectionState}
                  profiles={profiles}
                  appInfo={appInfo}
                  systemProxy={systemProxy}
                  updaterStatus={updaterStatus}
                  onCheckForUpdates={() => window.soul.checkForUpdates()}
                  onDownloadUpdate={() => window.soul.downloadUpdate()}
                  onDownloadAndInstall={downloadAndInstall}
                  onInstallUpdate={installUpdate}
                  onCancelUpdateDownload={cancelUpdateDownload}
                  onCancelAutoInstall={cancelAutoInstall}
                  onOpenUpdateFolder={() => window.soul.openUpdateFolder?.()}
                  shield={shield}
                  shieldProgress={shieldProgress}
                  onShieldTune={shieldActions.handleShieldTune}
                  onShieldCancel={shieldActions.handleShieldCancel}
                  onShieldClear={shieldActions.handleShieldClear}
                  onShieldManualKey={shieldActions.handleShieldManualKey}
                  onUpdate={settingsActions.handleUpdateSettings}
                  onUpdateChecked={settingsActions.handleUpdateSettingsChecked}
                  onOpenLogsFolder={() => window.soul.openLogsFolder()}
                  onExportBackup={settingsActions.handleExportBackup}
                  onImportBackup={settingsActions.handleImportBackup}
                  onResetUsage={settingsActions.handleResetUsage}
                  onResetAllUsage={settingsActions.handleResetAllUsage}
                  onSystemProxySetDesired={systemProxyActions.handleSystemProxySetDesired}
                  onSystemProxySync={systemProxyActions.handleSystemProxySync}
                  onOpenProxyFolder={systemProxyActions.handleOpenProxyFolder}
                  onResetNetworkDefaults={settingsActions.handleResetNetworkDefaults}
                  onResetAllSettings={settingsActions.handleResetAllSettings}
                  killSwitchBlocking={killSwitchBlocking}
                  health={health}
                  failover={failover}
                />
              )}
            </div>
          )}

          {failoverEvent && (
            <FailoverStatus event={failoverEvent} onDismiss={handleDismissFailover} />
          )}

          {killSwitchBlocking && (
            <div className="killswitch-banner" role="alert">
              <Icon name="shield" size={16} />
              <span className="killswitch-banner-text">
                Kill Switch فعال است — تمام ترافیک اینترنت مسدود شده تا وقتی دوباره وصل شوی.
              </span>
              <button className="btn danger killswitch-banner-btn" onClick={settingsActions.handleEmergencyDisableKillSwitch}>
                غیرفعال‌سازی اضطراری
              </button>
            </div>
          )}

          <StatusBar
            connectionState={connection.heroPhase}
            activeProfile={activeProfile}
            connectedAt={connectedAt}
            selectedPing={activeProfileId ? pingMs(pinger.pings[activeProfileId]) : undefined}
            killSwitchBlocking={killSwitchBlocking}
            notice={toast}
          />
        </main>
      </div>

      {finderOpen && (
        <ServerFinder
          profiles={profiles}
          subscriptions={subscriptions}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onClose={() => setFinderOpen(false)}
          onConnect={connection.handleConnectTo}
          onToggleFavorite={library.handleToggleFavorite}
        />
      )}

      {library.showAdd && (
        <AddModal
          onClose={library.closeAdd}
          onAddLink={library.handleAddLink}
          onAddSubscription={library.handleAddSubscription}
          onAddCustom={library.handleAddCustom}
        />
      )}
    </div>
  );
}
