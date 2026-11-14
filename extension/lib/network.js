import { normalizeSettings } from './settings.js';

export const RULESET_IDS = Object.freeze(['ads', 'trackers']);
export const ALLOW_RULE_ID_START = 100000;
export const ALLOW_RULE_ID_END = 100099;
export const ALLOW_RULE_PRIORITY = 10000;

export function desiredRulesets(settings) {
  const normalized = normalizeSettings(settings);
  if (!normalized.enabled) return [];
  return RULESET_IDS.filter((id) => normalized[id]);
}

export function buildAllowlistRules(settings) {
  const normalized = normalizeSettings(settings);
  if (!normalized.enabled) return [];
  return normalized.siteAllowlist.map((hostname, index) => ({
    id: ALLOW_RULE_ID_START + index,
    priority: ALLOW_RULE_PRIORITY,
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [hostname],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }));
}

function isOwnedRule(rule) {
  return rule.id >= ALLOW_RULE_ID_START && rule.id <= ALLOW_RULE_ID_END;
}

function sameRules(actual, expected) {
  // Browser responses can contain properties in a different order.
  const orderKeys = (value) => {
    if (Array.isArray(value)) return value.map(orderKeys).sort();
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, orderKeys(value[key])]));
    }
    return value;
  };
  const canonical = (rules) => rules.map(orderKeys).sort((a, b) => a.id - b.id);
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

/** Apply frame exceptions before enabling blockers to avoid a temporary unpaused site. */
export async function applyNetworkSettings(dnr, settings) {
  const wanted = desiredRulesets(settings);
  const active = await dnr.getEnabledRulesets();
  const disableRulesetIds = active.filter((id) => RULESET_IDS.includes(id) && !wanted.includes(id));
  if (disableRulesetIds.length) await dnr.updateEnabledRulesets({ disableRulesetIds });

  const existing = (await dnr.getDynamicRules()).filter(isOwnedRule);
  const desired = buildAllowlistRules(settings);
  if (!sameRules(existing, desired)) {
    await dnr.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: desired,
    });
  }

  const enableRulesetIds = wanted.filter((id) => !active.includes(id));
  if (enableRulesetIds.length) await dnr.updateEnabledRulesets({ enableRulesetIds });
}
