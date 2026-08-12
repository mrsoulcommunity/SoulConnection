'use strict';
// The plan a connection is built from. Both answers have to be settled before
// ports are allocated, because the dispatcher decision changes the whole port
// layout -- so this is where "does this edit need a reconnect?" is decided too.
const test = require('node:test');
const assert = require('node:assert');
const { buildRoutingPlan, planSignature } = require('../electron/vpn/routingPlan.cjs');
const rulesLib = require('../electron/lib/routing/rules.cjs');

const rule = (patch) => rulesLib.normalizeRule(patch);

test('domain-only rules need no dispatcher', () => {
  const plan = buildRoutingPlan({
    mode: 'smart',
    lanDirect: true,
    rules: [rule({ domain: 'example.com', route: 'direct' })],
  });
  assert.equal(plan.useDispatcher, false);
  assert.deepEqual(plan.rules, plan.fallbackRules, 'nothing to fall back from');
});

test('a rule naming an executable puts the dispatcher in the path', () => {
  const plan = buildRoutingPlan({
    mode: 'smart',
    lanDirect: true,
    rules: [rule({ exe: 'firefox.exe', route: 'direct' })],
  });
  assert.equal(plan.useDispatcher, true);
  // The fallback is the same policy without per-app routing: domain rules
  // survive, so a dispatcher that cannot bind degrades instead of failing.
  assert.notDeepEqual(plan.rules, plan.fallbackRules);
  assert.ok(plan.fallbackRules.length > 0);
});

test('tunnel mode keeps the declarative rules behind the dispatcher tags', () => {
  const policy = {
    mode: 'smart',
    lanDirect: true,
    rules: [rule({ exe: 'firefox.exe', route: 'direct' }), rule({ domain: 'example.com', route: 'proxy' })],
  };
  const proxyPlan = buildRoutingPlan(policy, 'proxy');
  const tunPlan = buildRoutingPlan(policy, 'tun');

  // Tunnel traffic never reaches the dispatcher -- there is no local listener
  // in its path -- so it still needs the plain rules appended.
  assert.ok(tunPlan.rules.length > proxyPlan.rules.length);
  assert.deepEqual(tunPlan.rules.slice(0, proxyPlan.rules.length), proxyPlan.rules);
});

test('the signature only moves when what xray runs moves', () => {
  const base = { mode: 'proxy', lanDirect: true, rules: [] };
  const same = planSignature(buildRoutingPlan(base));
  assert.equal(planSignature(buildRoutingPlan({ ...base })), same);

  // A per-app rule is executed by the dispatcher, which re-reads the policy on
  // every connection -- but adding the first one does change the layout.
  const withApp = planSignature(buildRoutingPlan({
    ...base, mode: 'smart', rules: [rule({ exe: 'a.exe', route: 'direct' })],
  }));
  assert.notEqual(withApp, same);

  // A second app rule changes nothing xray sees: same tags, same outbounds.
  const withTwoApps = planSignature(buildRoutingPlan({
    ...base,
    mode: 'smart',
    rules: [rule({ exe: 'a.exe', route: 'direct' }), rule({ exe: 'b.exe', route: 'proxy' })],
  }));
  assert.equal(withTwoApps, withApp, 'editing app rules must not demand a reconnect');
});

test('a domain rule change does demand a reconnect', () => {
  const before = planSignature(buildRoutingPlan({ mode: 'smart', lanDirect: true, rules: [] }));
  const after = planSignature(buildRoutingPlan({
    mode: 'smart', lanDirect: true, rules: [rule({ domain: 'example.com', route: 'direct' })],
  }));
  assert.notEqual(before, after);
});
