export const ACTIVITY_KINDS = Object.freeze(['cosmeticHidden', 'youtubeSkipped']);
export const EMPTY_STATS = Object.freeze({ cosmeticHidden: 0, youtubeSkipped: 0 });
export const MAX_ACTIVITY_ITEMS = 20;

export function normalizeStats(value) {
  return Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind,
    Number.isSafeInteger(value?.[kind]) && value[kind] >= 0 ? value[kind] : 0]));
}

export function normalizeActivity(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => ACTIVITY_KINDS.includes(item?.kind)
    && Number.isSafeInteger(item.count) && item.count > 0
    && Number.isSafeInteger(item.at) && item.at > 0)
    .slice(0, MAX_ACTIVITY_ITEMS)
    .map(({ kind, count, at }) => ({ kind, count, at }));
}

export function recordActivity(stats, activity, kind, count, at) {
  if (!ACTIVITY_KINDS.includes(kind) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('Invalid activity.');
  }
  const nextStats = normalizeStats(stats);
  nextStats[kind] = Math.min(Number.MAX_SAFE_INTEGER, nextStats[kind] + count);
  const nextActivity = normalizeActivity(activity);
  if (nextActivity[0]?.kind === kind && at - nextActivity[0].at < 60000) {
    nextActivity[0] = { kind, count: Math.min(Number.MAX_SAFE_INTEGER, nextActivity[0].count + count), at };
  } else {
    nextActivity.unshift({ kind, count, at });
  }
  return { stats: nextStats, activity: nextActivity.slice(0, MAX_ACTIVITY_ITEMS) };
}

/** A bounded in-memory limiter: no URL, title, or browsing history is retained. */
export function createActivityLimiter({ windowMs = 60000, maxKeys = 200 } = {}) {
  const buckets = new Map();
  return {
    take(key, kind, count, now = Date.now()) {
      if (!ACTIVITY_KINDS.includes(kind) || !Number.isSafeInteger(count) || count < 1 || count > 500) return 0;
      const limit = kind === 'youtubeSkipped' ? 20 : 500;
      const bucketKey = `${key}:${kind}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket || now - bucket.start >= windowMs || now < bucket.start) {
        if (!bucket && buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        bucket = { start: now, count: 0 };
        buckets.set(bucketKey, bucket);
      }
      const accepted = Math.max(0, Math.min(count, limit - bucket.count));
      bucket.count += accepted;
      return accepted;
    },
    clear() { buckets.clear(); },
  };
}

export function isExtensionPageSender(sender, extensionId) {
  if (sender?.id !== extensionId || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId;
  } catch {
    return false;
  }
}

export function contentSenderHostname(sender, extensionId) {
  if (sender?.id !== extensionId || !Number.isInteger(sender.tab?.id) || typeof sender.url !== 'string') return null;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}
