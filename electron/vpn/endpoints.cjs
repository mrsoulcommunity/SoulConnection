'use strict';
// "Which address and port do I dial, for what purpose?" -- answered once.
//
// There are three different right answers for a single live session, and
// getting them mixed up produces measurements that are confidently wrong
// rather than obviously broken:
//
//   probe        xray's OWN http inbound. With Smart Routing's dispatcher in
//                front, the public port is subject to the user's rules and may
//                legitimately answer a probe over a DIRECT connection -- which
//                for a latency check reports the distance to nothing, and for
//                an exit-IP lookup reports the user's real address while
//                claiming it is the tunnel's.
//   systemProxy  the PUBLIC http port. That is the listener the rest of the
//                machine can reach, and with Smart Routing on it is the one
//                that applies the user's rules -- exactly what system traffic
//                should be subject to.
//   localProxy   whichever public listener the user asked about, for the
//                Network settings "test connection" button.
//
// All three used to be computed inline at their call sites, three times over,
// each re-deriving the dispatcher check from `currentPorts.probeHttpPort !==
// currentPorts.httpPort`. They are one module now so they cannot drift apart.

// The address the app itself must dial to reach its own local proxy. The
// listener host is user-configurable (Network settings even advertises 0.0.0.0
// as "reachable from the LAN") but a wildcard bind is not a connectable
// address -- and is not what Windows should be pointed at as a system proxy
// either.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);

function dialHost(host) {
  const h = String(host || '').trim();
  return !h || WILDCARD_HOSTS.has(h) ? '127.0.0.1' : h;
}

// The dispatcher, when active, is the only reason probe and public ports
// differ, and it always listens on loopback.
function probeTarget(session, settings = {}) {
  if (!session) return null;
  const { probeHttpPort, httpPort } = session.ports;
  const throughDispatcher = probeHttpPort !== httpPort;
  return {
    host: throughDispatcher ? '127.0.0.1' : dialHost(settings.httpHost),
    port: probeHttpPort,
    username: settings.httpUsername || '',
    password: settings.httpPassword || '',
  };
}

function systemProxyTarget(session, settings = {}) {
  if (!session) return { connected: false };
  return {
    connected: true,
    host: dialHost(settings.httpHost),
    port: session.ports.httpPort,
  };
}

function localProxyTarget(session, settings = {}, protocol = 'http') {
  if (!session) return null;
  const isSocks = protocol === 'socks';
  return {
    protocol,
    host: dialHost(isSocks ? settings.socksHost : settings.httpHost),
    port: isSocks ? session.ports.socksPort : session.ports.httpPort,
    username: (isSocks ? settings.socksUsername : settings.httpUsername) || '',
    password: (isSocks ? settings.socksPassword : settings.httpPassword) || '',
  };
}

module.exports = { dialHost, probeTarget, systemProxyTarget, localProxyTarget, WILDCARD_HOSTS };
