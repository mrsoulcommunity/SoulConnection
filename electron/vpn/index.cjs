'use strict';
// The composition root of the VPN.
//
// This is the only file that knows which implementation is the real
// implementation: an actual xray process, actual Windows routes, the actual
// registry. vpn/core.cjs coordinates them and knows none of that, which is what
// makes the coordination testable on a machine with no xray, no Windows and no
// network.
//
// main.cjs calls createVpnCore() once and then talks to the object it gets
// back. Nothing else in the app constructs anything from vpn/.
const fs = require('fs');

const { VpnCore } = require('./core.cjs');
const { ConnectionMachine } = require('./machine.cjs');
const { Tunnel } = require('./tunnel.cjs');
const { DispatcherHost } = require('./dispatcherHost.cjs');
const { Telemetry } = require('./telemetry.cjs');
const { TunnelStatusTracker } = require('./tunnelStatus.cjs');
const { KillSwitchGuard } = require('./killSwitchGuard.cjs');
const { ReconnectPolicy } = require('./reconnect.cjs');

const { XrayProcess } = require('../lib/xrayProcess.cjs');
const { TunNetwork } = require('../lib/tunNetwork.cjs');
const { SystemProxyController } = require('../lib/systemProxyController.cjs');
const { StatsClient } = require('../lib/statsApi.cjs');
const { ProcessLookup } = require('../lib/routing/processLookup.cjs');
const { HealthMonitor } = require('../lib/health/monitor.cjs');
const { FailoverController, modeConfig } = require('../lib/health/failover.cjs');
const { findFreePort } = require('../lib/freePort.cjs');
const { proxyPing } = require('../lib/proxyPing.cjs');
const { lookupPublicIp } = require('../lib/publicIp.cjs');
const { testLocalProxy } = require('../lib/localProxyTest.cjs');
const killSwitchRules = require('../lib/killSwitch.cjs');
const serverTest = require('../lib/serverTest.cjs');
const routingRulesLib = require('../lib/routing/rules.cjs');
const { buildXrayConfig, TUN_NAME, TUN_ADDRESS, TUN_GATEWAY, TUN_PREFIX, TUN_DNS } = require('../lib/xrayConfig.cjs');

const MAX_PROXY_LOGS = 300;
const MISSING_XRAY = 'فایل xray.exe پیدا نشد. احتمالاً آنتی‌ویروس آن را حذف یا قرنطینه کرده. لطفاً پوشه‌ی برنامه را به لیست استثناهای آنتی‌ویروس اضافه کن و برنامه را دوباره نصب/اجرا کن.';

/**
 * @param {object} deps
 * @param {object}   deps.store              JsonStore
 * @param {function} deps.getSettings        () => settings
 * @param {function} deps.findProfile        (id) => profile | undefined
 * @param {function} deps.getRoutingPolicy   () => { mode, lanDirect, rules }
 * @param {function} [deps.getShieldKey]     (profile) => string
 * @param {function} [deps.getFailoverCandidates] (limit) => profile[]
 * @param {function} [deps.selectOnReconnect] ({profileId, signal}) => Promise<id>
 * @param {function} deps.notify             (title, body) => void
 * @param {function} deps.emit               (channel, payload) => void
 * @param {string}   deps.xrayBin
 * @param {string}   deps.xrayAssetDir
 * @param {string}   deps.workDir
 */
function createVpnCore(deps) {
  const { store, getSettings, xrayBin, xrayAssetDir, workDir, notify, emit } = deps;
  const log = deps.log || (() => {});
  const send = emit || (() => {});

  // ---- the transport ----
  const xray = new XrayProcess(xrayBin, workDir, xrayAssetDir);
  const tunNetwork = new TunNetwork({ log });
  const processLookup = new ProcessLookup();

  const dispatcherHost = new DispatcherHost({
    processLookup,
    // Read through the policy on every connection rather than closing over a
    // snapshot, so app-rule edits take effect without a reconnect.
    resolveRoute: ({ exe, host, port }) => {
      const policy = deps.getRoutingPolicy();
      return routingRulesLib.matchRoute({ exe, host, port }, policy.rules, {
        mode: policy.mode,
        lanDirect: policy.lanDirect,
      }).route;
    },
  });

  const tunnel = new Tunnel({
    xray,
    tunNetwork,
    dispatcherHost,
    buildConfig: buildXrayConfig,
    tunConfig: {
      name: TUN_NAME,
      address: TUN_ADDRESS,
      prefixLength: TUN_PREFIX,
      gateway: TUN_GATEWAY,
      dnsServers: TUN_DNS,
    },
    log,
  });

  // ---- the log ring ----
  //
  // Capped so a freshly opened log panel isn't empty, and forwarded live.
  const logRing = [];
  xray.on('log', (text) => {
    const entry = { t: Date.now(), text: text.trim() };
    logRing.push(entry);
    if (logRing.length > MAX_PROXY_LOGS) logRing.splice(0, logRing.length - MAX_PROXY_LOGS);
    send('proxy-log', entry);
    log(`[xray] ${entry.text}`);
  });

  // ---- everything that follows the session ----
  const telemetry = new Telemetry({
    getSettings,
    proxyPing: (target) => proxyPing(target),
    createStatsClient: (apiPort) => new StatsClient(apiPort),
    getLifetimeBytes: (profileId) => {
      const p = deps.findProfile(profileId);
      return (p && p.totalBytes) || 0;
    },
    emit: send,
  });

  const tunnelStatus = new TunnelStatusTracker({
    lookupPublicIp,
    getSettings,
    getServerAddress: (profileId) => {
      const p = deps.findProfile(profileId);
      return p ? p.address : null;
    },
    emit: (status) => send('tunnel-status', status),
    log,
  });

  const killSwitch = new KillSwitchGuard({
    killSwitch: killSwitchRules,
    xrayBin,
    isEnabled: () => !!getSettings().killSwitchEnabled,
    notify,
    onChange: () => core.emit('changed'),
  });

  // The tunnel it points Windows at is always the PUBLIC http port -- see
  // vpn/endpoints.cjs for why that is the opposite choice from the probes --
  // and it is withdrawn the moment the core starts retiring a session, before
  // the listener stops accepting connections.
  const systemProxy = new SystemProxyController({
    store,
    getSettings,
    getTunnel: () => core.proxyTarget(),
    onChange: (status) => send('system-proxy-status', status),
    notify,
  });

  const health = new HealthMonitor({
    probeActive: () => core.probeLiveTunnel(),
    probeTcp: (profile, opts) => serverTest.tcpPingStats(profile.address, profile.port, opts),
    probeTunnel: (profile, { signal }) => serverTest.realPing(profile, {
      xrayBin, xrayAssetDir, workRoot: workDir, signal, warmCount: 2,
    }),
  });

  const failover = new FailoverController({
    monitor: health,
    getConfig: () => {
      const s = getSettings();
      return { enabled: !!s.failoverEnabled, mode: s.failoverMode };
    },
    getCurrentId: () => store.get('activeProfileId', null),
  });

  const core = new VpnCore({
    machine: new ConnectionMachine(),
    tunnel,
    telemetry,
    tunnelStatus,
    killSwitch,
    systemProxy,
    health,
    failover,
    reconnectPolicy: new ReconnectPolicy(),
    dispatcherHost,

    store,
    getSettings,
    findProfile: deps.findProfile,
    getRoutingPolicy: deps.getRoutingPolicy,
    getShieldKey: deps.getShieldKey,
    getFailoverCandidates: deps.getFailoverCandidates,
    selectOnReconnect: deps.selectOnReconnect,

    findFreePort,
    proxyPing,
    testLocalProxy,
    xrayExists: () => fs.existsSync(xrayBin),
    probeCadence: (settings) => modeConfig(settings.failoverMode).probeMs,
    // A crash or force-quit leaves the /1 routes in the table pointing at an
    // adapter that died with the process. Matched strictly by the tunnel
    // gateway address, so nothing else is ever touched.
    reconcileStaleRoutes: () => TunNetwork.reconcileStale(TUN_GATEWAY),
    teardownRoutes: () => tunNetwork.teardown(),
    recentLogs: () => logRing,
    missingBinaryMessage: MISSING_XRAY,

    notify,
    emit: send,
    log,
  });

  // Platform wording for the two failures a user can actually do something
  // about. Everything else is passed through with the message xray gave.
  core.describeConnectError = (err, mode) => {
    if (mode === 'tun' && /access is denied/i.test(err.message || '')) {
      return new Error('حالت تانل نیاز به اجرای برنامه با دسترسی مدیر (Administrator) دارد');
    }
    if (err.code === 'ENOENT') return new Error(MISSING_XRAY);
    return err;
  };

  return core;
}

module.exports = { createVpnCore, MISSING_XRAY };
