'use strict';
// Everything a session listens on, worked out in one pass.
//
// The ports are user-configurable and any of them can be occupied by something
// else on the machine, so each preferred port may be bumped to a free one. That
// made the old inline version a chain of special cases -- "if HTTP ended up
// equal to SOCKS, ask for the next one; if the API port equals either, ask for
// the one after HTTP" -- which covered the pairs it thought of and missed the
// rest. The dispatcher's four private ports were asked for independently, so a
// busy 20808 handed 20809 to the first one and then, because nothing was bound
// yet, 20809 to the second as well: two inbounds on one port, and xray refusing
// the config.
//
// The fix is to stop treating them as independent requests. `reserve()` keeps
// every port it has already handed out and walks past any repeat, so a
// collision is impossible by construction rather than by enumeration.

// Preferred defaults. The dispatcher's block sits well clear of the
// user-configurable range so a custom SOCKS/HTTP port cannot collide with it.
const DEFAULT_SOCKS_PORT = 10808;
const DEFAULT_HTTP_PORT = 10809;
const DEFAULT_API_PORT = 10810;
const DISPATCH_PORT_BASE = 20808;

/**
 * @param {object} opts
 * @param {object} opts.settings          user settings (socksPort/httpPort)
 * @param {boolean} [opts.useDispatcher]  Smart Routing owns the public ports
 * @param {function} opts.findFreePort    (preferred) => Promise<number>
 * @returns {Promise<{socksPort:number, httpPort:number, apiPort:number, dispatch:object|null}>}
 */
async function allocatePorts({ settings = {}, useDispatcher = false, findFreePort }) {
  if (typeof findFreePort !== 'function') throw new Error('allocatePorts needs findFreePort');

  const taken = new Set();
  const reserve = async (preferred) => {
    let want = preferred;
    // Skip anything already handed out in this same allocation: findFreePort
    // only knows what the OS has bound, and nothing here is bound yet.
    while (taken.has(want)) want++;
    const port = await findFreePort(want);
    // findFreePort can fall back to an OS-assigned ephemeral port, which is
    // free as far as the OS is concerned but could still be one we just picked.
    const final = taken.has(port) ? await reserve(port + 1) : port;
    taken.add(final);
    return final;
  };

  const socksPort = await reserve(settings.socksPort || DEFAULT_SOCKS_PORT);
  const httpPort = await reserve(settings.httpPort || DEFAULT_HTTP_PORT);
  const apiPort = await reserve(DEFAULT_API_PORT);

  const dispatch = useDispatcher ? {
    proxySocks: await reserve(DISPATCH_PORT_BASE),
    proxyHttp: await reserve(DISPATCH_PORT_BASE + 1),
    directSocks: await reserve(DISPATCH_PORT_BASE + 2),
    directHttp: await reserve(DISPATCH_PORT_BASE + 3),
  } : null;

  return { socksPort, httpPort, apiPort, dispatch };
}

module.exports = {
  allocatePorts,
  DEFAULT_SOCKS_PORT,
  DEFAULT_HTTP_PORT,
  DEFAULT_API_PORT,
  DISPATCH_PORT_BASE,
};
