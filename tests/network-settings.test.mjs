import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, applySettingsPatch, isSiteAllowed, normalizeHostname,
  normalizeSettings, toggleSiteSetting,
} from '../extension/lib/settings.js';
import { applyNetworkSettings, buildAllowlistRules, desiredRulesets } from '../extension/lib/network.js';
import {
  contentSenderHostname, createActivityLimiter, isExtensionPageSender,
  normalizeActivity, normalizeStats, recordActivity,
} from '../extension/lib/activity.js';

test('hostnames are canonical and do not accept URL/path/wildcard injection', () => {
  assert.equal(normalizeHostname(' WWW.Example.COM. '), 'www.example.com');
  assert.equal(normalizeHostname('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeHostname('127.0.0.1'), '127.0.0.1');
  for (const host of [null, '', 'https://example.com', '*.example.com', '.example.com',
    'example.com:443', 'example.com/path', 'good.example@evil.example', 'x y.com',
    'example..com', '-example.com', 'example-.com', 'example.com?x', 'a%2eb.com',
    '1.2.3.999', '127.1', '0x7f000001', 'a'.repeat(64) + '.com']) {
    assert.equal(normalizeHostname(host), null, String(host));
  }
});

test('site exceptions respect hostname label boundaries and IDNs', () => {
  const sites = ['example.com', 'xn--bcher-kva.example'];
  assert.equal(isSiteAllowed('example.com', sites), true);
  assert.equal(isSiteAllowed('a.b.example.com', sites), true);
  assert.equal(isSiteAllowed('notexample.com', sites), false);
  assert.equal(isSiteAllowed('example.com.evil.test', sites), false);
  assert.equal(isSiteAllowed('bücher.example', sites), true);
});

test('persisted settings recover from malformed input while UI patches are strict', () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS, siteAllowlist: [] });
  assert.deepEqual(normalizeSettings({ enabled: 'false', trackers: false, siteAllowlist: ['x.com', 'X.com', 'https://evil.test'] }),
    { ...DEFAULT_SETTINGS, trackers: false, siteAllowlist: ['x.com'] });
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { ads: 'false' }), /true or false/);
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { unexpected: true }), /Unknown setting/);
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { siteAllowlist: ['https://example.com'] }), /hostname/);
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { siteAllowlist: Array.from({ length: 101 }, (_, n) => `site${n}.test`) }), /100/);
});

test('resuming a subdomain removes its inherited parent exception', () => {
  const settings = { ...DEFAULT_SETTINGS, siteAllowlist: ['example.com', 'other.test'] };
  assert.deepEqual(toggleSiteSetting(settings, 'news.example.com', false).siteAllowlist, ['other.test']);
  assert.deepEqual(toggleSiteSetting(settings, 'news.example.com', true).siteAllowlist, ['example.com', 'other.test']);
  assert.deepEqual(toggleSiteSetting(settings, 'new.test', true).siteAllowlist, ['example.com', 'new.test', 'other.test']);
});

test('master switch and category settings produce independent ruleset selections', () => {
  assert.deepEqual(desiredRulesets(DEFAULT_SETTINGS), ['ads', 'trackers']);
  assert.deepEqual(desiredRulesets({ ...DEFAULT_SETTINGS, ads: false }), ['trackers']);
  assert.deepEqual(desiredRulesets({ ...DEFAULT_SETTINGS, enabled: false }), []);
  const rules = buildAllowlistRules({ ...DEFAULT_SETTINGS, siteAllowlist: ['z.test', 'a.test'] });
  assert.deepEqual(rules.map((rule) => rule.condition.requestDomains), [['a.test'], ['z.test']]);
  assert.equal(rules[0].action.type, 'allowAllRequests');
  assert.ok(rules[0].priority > 1);
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(buildAllowlistRules({ ...DEFAULT_SETTINGS, enabled: false, siteAllowlist: ['a.test'] }), []);
});

function fakeDnr({ active = [], dynamic = [] } = {}) {
  const state = { active: [...active], dynamic: structuredClone(dynamic), calls: [] };
  const api = {
    async getEnabledRulesets() { return [...state.active]; },
    async getDynamicRules() { return structuredClone(state.dynamic); },
    async updateEnabledRulesets(change) {
      state.calls.push(['static', change]);
      state.active = [...new Set([...state.active.filter((id) => !(change.disableRulesetIds || []).includes(id)), ...(change.enableRulesetIds || [])])];
    },
    async updateDynamicRules(change) {
      state.calls.push(['dynamic', change]);
      state.dynamic = state.dynamic.filter((rule) => !change.removeRuleIds.includes(rule.id)).concat(change.addRules);
    },
  };
  return { state, api };
}

test('network state applies exceptions before enabling rules and preserves unrelated rules', async () => {
  const foreign = { id: 777, action: { type: 'block' }, condition: { urlFilter: 'example.test' } };
  const { state, api } = fakeDnr({ dynamic: [foreign] });
  const settings = { ...DEFAULT_SETTINGS, siteAllowlist: ['example.com'] };
  await applyNetworkSettings(api, settings);
  assert.deepEqual(state.calls.map((call) => call[0]), ['dynamic', 'static']);
  assert.deepEqual(state.active, ['ads', 'trackers']);
  assert.deepEqual(state.dynamic, [foreign, ...buildAllowlistRules(settings)]);
  state.calls = [];
  await applyNetworkSettings(api, settings);
  assert.deepEqual(state.calls, [], 'unchanged settings avoid browser mutations');
  await applyNetworkSettings(api, { ...settings, enabled: false });
  assert.deepEqual(state.calls.map((call) => call[0]), ['static', 'dynamic']);
  assert.deepEqual(state.active, []);
  assert.deepEqual(state.dynamic, [foreign]);
});

test('network reconciliation replaces a stale exception with extra condition restrictions', async () => {
  const settings = { ...DEFAULT_SETTINGS, siteAllowlist: ['example.com'] };
  const stale = buildAllowlistRules(settings);
  stale[0].condition.initiatorDomains = ['unexpected.test'];
  const { state, api } = fakeDnr({ active: ['ads', 'trackers'], dynamic: stale });
  await applyNetworkSettings(api, settings);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.dynamic, buildAllowlistRules(settings));
});

test('activity stores only bounded counters and sanitized event fields', () => {
  assert.deepEqual(normalizeStats({ cosmeticHidden: -5, youtubeSkipped: 2, url: 'private' }), { cosmeticHidden: 0, youtubeSkipped: 2 });
  assert.deepEqual(normalizeActivity([{ kind: 'cosmeticHidden', count: 2, at: 1, url: 'private' }]), [{ kind: 'cosmeticHidden', count: 2, at: 1 }]);
  const result = recordActivity({ cosmeticHidden: 3, youtubeSkipped: 1 }, [{ kind: 'cosmeticHidden', count: 3, at: 100 }], 'cosmeticHidden', 4, 200);
  assert.deepEqual(result.stats, { cosmeticHidden: 7, youtubeSkipped: 1 });
  assert.deepEqual(result.activity, [{ kind: 'cosmeticHidden', count: 7, at: 200 }]);
  assert.throws(() => recordActivity({}, [], 'visited', 1, 100), /Invalid/);
});

test('activity limits bursts and rejects malformed counts', () => {
  const limiter = createActivityLimiter();
  assert.equal(limiter.take('tab1', 'youtubeSkipped', 18, 0), 18);
  assert.equal(limiter.take('tab1', 'youtubeSkipped', 9, 1), 2);
  assert.equal(limiter.take('tab1', 'youtubeSkipped', 1, 2), 0);
  assert.equal(limiter.take('tab2', 'youtubeSkipped', 1, 2), 1);
  assert.equal(limiter.take('tab1', 'youtubeSkipped', 1, 60000), 1);
  assert.equal(limiter.take('tab1', 'cosmeticHidden', 501, 1), 0);
  assert.equal(limiter.take('tab1', 'cosmeticHidden', 1.2, 1), 0);
  assert.equal(limiter.take('tab1', 'unknown', 1, 1), 0);
});

test('sender privilege checks require browser supplied extension identity and origin', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(isExtensionPageSender({ id, url: `chrome-extension://${id}/popup.html` }, id), true);
  assert.equal(isExtensionPageSender({ id, url: 'https://example.com' }, id), false);
  assert.equal(isExtensionPageSender({ id: 'other', url: `chrome-extension://${id}/popup.html` }, id), false);
  assert.equal(contentSenderHostname({ id, tab: { id: 2 }, url: 'https://www.youtube.com/watch?v=private' }, id), 'www.youtube.com');
  assert.equal(contentSenderHostname({ id, url: 'https://example.com' }, id), null);
  assert.equal(contentSenderHostname({ id, tab: { id: 2 }, url: 'file:///private' }, id), null);
});
