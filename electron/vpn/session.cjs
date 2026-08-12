'use strict';
// One live tunnel, as a single value.
//
// WHY THIS EXISTS
// ---------------
// Everything a running tunnel *is* used to live in main.cjs as a handful of
// loose module-level variables -- `currentPorts`, `connectedAt`, the active
// profile id read back out of the store, plus whatever each subsystem cached
// about them. Nothing tied those together, so every consumer invented its own
// way to ask "is this still the same tunnel I was looking at?": the traffic
// poll compared `currentPorts` by reference, health monitoring and the tunnel
// probe each built a `${profileId}:${connectedAt}` string, and the rest simply
// re-read the globals and hoped.
//
// A session replaces all of that with one frozen object and one identity. It is
// created at the moment a tunnel is fully up, handed to every subsystem that
// needs to know about it, and never mutated -- a new tunnel is a new session
// with a new `id`, so "same session?" is `a.id === b.id` everywhere, and a
// result that arrives late can always be attributed to the tunnel it came from
// rather than the one that has since replaced it.

let sequence = 0;

/**
 * @param {object} init
 * @param {string} init.profileId    the server this tunnel is running
 * @param {string} [init.profileName] for logs and notifications
 * @param {'proxy'|'tun'} init.mode  connection mode this tunnel was built for
 * @param {object} init.ports        see vpn/ports.cjs -- the whole port layout
 * @param {string} [init.shieldKey]  anti-DPI treatment applied to the outbound
 * @param {boolean} [init.dispatcherActive] Smart Routing's dispatcher owns the
 *        public ports for this session
 */
function createSession({
  profileId,
  profileName = '',
  mode = 'proxy',
  ports,
  shieldKey = null,
  dispatcherActive = false,
  startedAt = Date.now(),
}) {
  return Object.freeze({
    id: ++sequence,
    profileId,
    profileName,
    mode,
    ports: Object.freeze({ ...ports }),
    shieldKey,
    dispatcherActive,
    startedAt,
  });
}

// True when both arguments describe the same live tunnel. Written as a function
// rather than left to each caller because "no session" has to compare equal to
// "no session" -- a subsystem that is idle must not restart itself every time
// it is asked to re-evaluate nothing.
function sameSession(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id;
}

module.exports = { createSession, sameSession };
