'use strict';
// Bringing one tunnel up, and taking it back down.
//
// Three things have to happen in a fixed order and come apart in the reverse
// one, and every step can fail:
//
//   1. xray            the process, with the config the routing plan asked for.
//   2. the dispatcher  only when a rule names an executable. It owns the public
//                      ports, so a failure to bind them is recoverable but not
//                      ignorable -- we rebuild xray on the plain layout instead.
//   3. the TUN network the adapter xray created is inert until something gives
//                      it an address and routes. Tunnel mode is a no-op without
//                      this step.
//
// The ordering constraints are not stylistic. Routes must come out before the
// adapter disappears, or the machine is left routing into an adapter that no
// longer exists and has no internet at all; the dispatcher must stop before
// xray, or it keeps accepting connections and forwarding them into ports
// nothing is listening on.
//
// CRASH DETECTION
// ---------------
// A `dropped` event means the tunnel died on its own -- crash, server-side
// kick, network change -- as opposed to us stopping it. This used to be an
// `expectedExit` boolean on main.cjs's module scope, assigned at four call
// sites, where forgetting to set it swallowed a real crash and setting it too
// eagerly left a stale `true` that swallowed the *next* one. Here it is a
// property of the object that owns the process: an exit is a drop exactly when
// there is a live session and we are not the ones ending it.
const { EventEmitter } = require('events');
const { createSession } = require('./session.cjs');

class Tunnel extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.xray            XrayProcess
   * @param {object} deps.tunNetwork      TunNetwork
   * @param {object} deps.dispatcherHost  DispatcherHost
   * @param {function} deps.buildConfig   (profile, opts) => xray config
   * @param {object} deps.tunConfig       { name, address, prefixLength, gateway, dnsServers }
   */
  constructor({ xray, tunNetwork, dispatcherHost, buildConfig, tunConfig, log = () => {} }) {
    super();
    this.xray = xray;
    this.tunNetwork = tunNetwork;
    this.dispatcherHost = dispatcherHost;
    this.buildConfig = buildConfig;
    this.tunConfig = tunConfig;
    this.log = log;

    this.session = null;
    this.closing = false;

    this.xray.on('exit', (code) => {
      if (!this.session || this.closing) return;
      const dropped = this.session;
      this.session = null;
      this.log(`[tunnel] xray exited unexpectedly (code ${code})`);
      this.emit('dropped', dropped);
    });
  }

  get active() {
    return this.session;
  }

  /**
   * Start everything, or leave the machine exactly as it was found.
   *
   * @returns {Promise<object>} the live session
   */
  async open({ profile, mode = 'proxy', settings, ports, routing, shieldKey = null, dnsServers = null }) {
    if (this.session) throw new Error('Tunnel is already open');
    this.closing = false;

    // The resolvers Windows hands to apps and the ones xray re-issues those
    // queries to have to be the same list, or the adapter advertises a server
    // whose answers never arrive. One value, both halves.
    const dns = (dnsServers && dnsServers.length) ? dnsServers : this.tunConfig.dnsServers;

    const baseOpts = {
      socksPort: ports.socksPort,
      httpPort: ports.httpPort,
      apiPort: ports.apiPort,
      mode,
      logLevel: settings.xrayLogLevel,
      socksHost: settings.socksHost,
      httpHost: settings.httpHost,
      socksAccounts: settings.socksUsername
        ? [{ user: settings.socksUsername, pass: settings.socksPassword || '' }] : undefined,
      httpAccounts: settings.httpUsername
        ? [{ user: settings.httpUsername, pass: settings.httpPassword || '' }] : undefined,
      routingRules: routing.rules,
      dnsServers: dns,
      // Whatever the shield measured for this server on this network. Plain
      // until a tune has run, so a first connect is never delayed by it.
      shield: shieldKey,
    };

    let dispatcherActive = false;
    let probeHttpPort = ports.httpPort;

    try {
      await this.xray.start(this.buildConfig(
        profile,
        routing.useDispatcher ? { ...baseOpts, dispatchPorts: ports.dispatch } : baseOpts
      ));

      if (routing.useDispatcher) {
        try {
          await this.dispatcherHost.start({ ports, settings });
          dispatcherActive = true;
          probeHttpPort = ports.dispatch.proxyHttp;
        } catch (err) {
          // Fall back to the plain layout -- domain rules still apply, only the
          // per-app ones are lost -- and say so rather than silently degrading.
          await this.dispatcherHost.stop();
          await this.xray.stop();
          await this.xray.start(this.buildConfig(profile, {
            ...baseOpts,
            routingRules: routing.fallbackRules,
          }));
          this.emit('notice', {
            title: 'قوانین مسیریابی',
            body: `مسیریاب برنامه‌ها اجرا نشد (${err.message}). فعلاً فقط قوانین دامنه اعمال می‌شود.`,
          });
        }
      }

      // Tunnel mode: xray has created the Wintun adapter, but Windows will not
      // send it a single packet until it has an address and routes.
      if (mode === 'tun') {
        await this.tunNetwork.apply({
          adapterName: this.tunConfig.name,
          address: this.tunConfig.address,
          prefixLength: this.tunConfig.prefixLength,
          gateway: this.tunConfig.gateway,
          dnsServers: dns,
          serverAddress: profile.address,
        });
      }

      this.session = createSession({
        profileId: profile.id,
        profileName: profile.name || '',
        mode,
        ports: { ...ports, probeHttpPort },
        shieldKey,
        dispatcherActive,
      });
      return this.session;
    } catch (err) {
      // Everything that went in has to come back out, in reverse order, before
      // the error reaches the caller. A surviving xray is not harmless: start()
      // rejects outright while one is alive, so every later connect would fail
      // with "Xray is already running" until the app was restarted.
      this.closing = true;
      try { await this.dispatcherHost.stop(); } catch { /* best effort */ }
      try { await this.tunNetwork.teardown(); } catch { /* best effort */ }
      try { await this.xray.stop(); } catch { /* already gone */ }
      this.session = null;
      this.closing = false;
      throw err;
    }
  }

  /**
   * Take it all down. Safe to call with nothing running, and each step is
   * best-effort: one failing command must not strand the rest of the cleanup,
   * because what is left behind is the user's internet connection.
   */
  async close() {
    const session = this.session;
    this.closing = true;
    try {
      await this.dispatcherHost.stop();
      // Before xray goes away: once the adapter disappears, routes pointing
      // into it are dead ends.
      await this.tunNetwork.teardown();
      await this.xray.stop();
    } finally {
      this.session = null;
      this.closing = false;
    }
    return session;
  }

  /**
   * Post-crash cleanup: the process is already gone, but whatever it was
   * paired with is not. Same order as close(), without stopping a process that
   * has stopped itself.
   */
  async cleanupAfterDrop() {
    this.closing = true;
    try {
      await this.dispatcherHost.stop();
      await this.tunNetwork.teardown();
    } finally {
      this.closing = false;
    }
  }
}

module.exports = { Tunnel };
