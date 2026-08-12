'use strict';
// Tunnel-mode DNS. Two things read this setting -- the Windows adapter (via
// vpn/tunnel.cjs) and xray's own resolver -- and they have to agree, or the
// adapter advertises a server whose answers never arrive.
const test = require('node:test');
const assert = require('node:assert');
const { buildXrayConfig, TUN_DNS } = require('../electron/lib/xrayConfig.cjs');

const profile = {
  id: 'p1', name: 'Tokyo', address: 'jp.example.net', port: 443,
  protocol: 'vless', uuid: '11111111-2222-3333-4444-555555555555',
};

const dohFor = (config) => config.dns.servers.filter((s) => typeof s === 'string');
const pinnedResolver = (config) => config.dns.servers.find((s) => typeof s === 'object');

test('proxy mode carries no DNS block at all', () => {
  const config = buildXrayConfig(profile, { mode: 'proxy' });
  assert.equal(config.dns, undefined, 'apps use the system resolver; nothing is hijacked');
});

test('tunnel mode re-issues the configured resolvers over DoH', () => {
  const config = buildXrayConfig(profile, { mode: 'tun', dnsServers: ['9.9.9.9', '1.0.0.1'] });
  // DoH, not UDP: plenty of servers (and CDN-fronted WebSocket setups) do not
  // relay UDP, and when they don't, nothing resolves and every app looks broken.
  assert.deepEqual(dohFor(config), ['https://9.9.9.9/dns-query', 'https://1.0.0.1/dns-query']);
});

test('the server hostname is pinned to the first configured resolver', () => {
  // The one name that cannot be resolved through the tunnel: the tunnel does
  // not exist yet. It gets a plain resolver, pinned direct by a routing rule.
  const config = buildXrayConfig(profile, { mode: 'tun', dnsServers: ['9.9.9.9'] });
  const pinned = pinnedResolver(config);
  assert.equal(pinned.address, '9.9.9.9');
  assert.deepEqual(pinned.domains, ['full:jp.example.net']);
  assert.equal(pinned.skipFallback, true);
});

test('no configured resolvers falls back to the built-in defaults', () => {
  for (const opts of [{ mode: 'tun' }, { mode: 'tun', dnsServers: [] }, { mode: 'tun', dnsServers: null }]) {
    const config = buildXrayConfig(profile, opts);
    assert.deepEqual(dohFor(config), TUN_DNS.map((ip) => `https://${ip}/dns-query`));
  }
});

test('an IP-literal server needs no pinned resolver', () => {
  const config = buildXrayConfig({ ...profile, address: '203.0.113.7' }, { mode: 'tun' });
  assert.equal(pinnedResolver(config), undefined);
});

test('tunnel mode keeps withholding AAAA answers', () => {
  // Only 0.0.0.0/1 and 128.0.0.0/1 are captured, so any IPv6 an app obtained
  // would leave the machine outside the tunnel.
  const config = buildXrayConfig(profile, { mode: 'tun', dnsServers: ['9.9.9.9'] });
  assert.equal(config.dns.queryStrategy, 'UseIPv4');
});
