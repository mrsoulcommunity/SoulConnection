'use strict';
// Turns the user's routing policy into the two things a connection needs to
// know before it can start: whether the Smart Routing dispatcher has to be in
// the path, and the exact rule list xray will run.
//
// Both answers have to be settled *before* ports are allocated -- the
// dispatcher decision changes the entire port layout -- which is why this is a
// plan computed up front rather than something discovered while connecting.
//
// `fallbackRules` is the same policy expressed without a dispatcher. The
// dispatcher owns the public ports, so if it cannot bind them the user would be
// left with a running tunnel nothing on the machine can reach; the connection
// re-runs with these instead, keeping domain rules and losing only the per-app
// ones.
const routingRules = require('../lib/routing/rules.cjs');
const { compileRoutingRules } = require('../lib/routing/xrayRouting.cjs');

/**
 * @param {object} policy  { mode, lanDirect, rules } -- already sanitized
 * @param {'proxy'|'tun'} mode  connection mode
 */
function buildRoutingPlan(policy, mode = 'proxy') {
  const useDispatcher = routingRules.needsDispatcher(policy.mode, policy.rules);
  const plain = () => compileRoutingRules({ ...policy, dispatcher: false });

  if (!useDispatcher) {
    const rules = plain();
    return { useDispatcher: false, rules, fallbackRules: rules };
  }

  const rules = compileRoutingRules({ ...policy, dispatcher: true });
  // Tunnel-mode traffic never reaches the dispatcher (there is no local
  // listener in its path), so it still needs the declarative rules appended
  // after the dispatcher's inbound-tag rules.
  if (mode === 'tun') rules.push(...plain());

  return { useDispatcher: true, rules, fallbackRules: plain() };
}

// The part of a plan that xray actually runs, as a comparable string. Only a
// change to *this* needs a reconnect: app rules live entirely in the
// dispatcher, which reads the policy fresh on every connection, so editing them
// takes effect immediately and silently.
function planSignature(plan) {
  return JSON.stringify([plan.useDispatcher, plan.rules]);
}

module.exports = { buildRoutingPlan, planSignature };
