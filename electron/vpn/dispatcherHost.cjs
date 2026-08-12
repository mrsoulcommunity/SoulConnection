'use strict';
// Owns the Smart Routing dispatcher's lifetime, and the process-lookup cache
// that only makes sense while it is running.
//
// The two were started and stopped together in main.cjs but tracked apart, in
// three variables (`dispatcher`, `dispatcherActive`, plus `processLookup`'s own
// cache) that every caller had to remember to keep in step. Anything that reads
// "is the dispatcher up?" now reads it from the thing that runs it.
const { Dispatcher } = require('../lib/routing/dispatcher.cjs');
const routingRules = require('../lib/routing/rules.cjs');

class DispatcherHost {
  /**
   * @param {object} deps
   * @param {function} deps.resolveRoute  ({exe, host, port}) => 'proxy'|'direct'|'block'
   * @param {object} deps.processLookup   ProcessLookup instance
   */
  constructor({ resolveRoute, processLookup }) {
    this.resolveRoute = resolveRoute;
    this.processLookup = processLookup;
    this.dispatcher = null;
  }

  get active() {
    return !!this.dispatcher;
  }

  get stats() {
    return this.dispatcher ? { ...this.dispatcher.stats } : null;
  }

  // Would this policy need the dispatcher at all? Only a rule naming an
  // executable does -- everything else is expressible as xray routing rules.
  neededFor(policy) {
    return routingRules.needsDispatcher(policy.mode, policy.rules);
  }

  /**
   * Bind the public ports and forward to the four private ones xray is
   * listening on. Throws if the public ports cannot be bound -- the caller
   * decides what to do about that, because the answer ("fall back to a plain
   * layout") involves restarting xray, which is not this object's business.
   */
  async start({ ports, settings }) {
    await this.stop();
    const dispatcher = new Dispatcher({
      // Read through the callback rather than closing over a snapshot: edits to
      // app rules then take effect on the next connection, with no reconnect.
      resolveRoute: this.resolveRoute,
      lookupExe: (srcPort) => this.processLookup.exeForPort(srcPort),
      targets: {
        proxy: { socksPort: ports.dispatch.proxySocks, httpPort: ports.dispatch.proxyHttp },
        direct: { socksPort: ports.dispatch.directSocks, httpPort: ports.dispatch.directHttp },
      },
      auth: { username: settings.socksUsername, password: settings.socksPassword },
    });
    await dispatcher.start({
      socksHost: settings.socksHost,
      socksPort: ports.socksPort,
      httpHost: settings.httpHost,
      httpPort: ports.httpPort,
    });
    this.dispatcher = dispatcher;
  }

  async stop() {
    if (this.dispatcher) {
      try { await this.dispatcher.stop(); } catch { /* best effort */ }
      this.dispatcher = null;
    }
    this.processLookup.clear();
  }
}

module.exports = { DispatcherHost };
