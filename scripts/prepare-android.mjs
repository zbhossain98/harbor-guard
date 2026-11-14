import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, 'android/app/src/main/assets');
await mkdir(assets, { recursive: true });
await mkdir(path.join(root, 'android/app/src/main/res/drawable'), { recursive: true });
const data = { ads: [], trackers: [], excludedRequests: [], excludedInitiators: [], allowances: [] };
const exclusions = new Set(), initiatorExclusions = new Set(), allowances = new Map();
for (const kind of ['ads', 'trackers']) {
  const rules = JSON.parse(await readFile(path.join(root, `extension/rules/${kind}.json`), 'utf8'));
  const hosts = new Set();
  for (const rule of rules) {
    const condition = rule.condition;
    if (rule.action.type === 'block') {
      if (!condition.requestDomains || condition.domainType !== 'thirdParty') throw new Error('Unexpected block syntax; review Android conversion');
      condition.requestDomains.forEach((host) => hosts.add(host));
      (condition.excludedRequestDomains || []).forEach((host) => exclusions.add(host));
      (condition.excludedInitiatorDomains || []).forEach((host) => initiatorExclusions.add(host));
    } else {
      const supported = ['urlFilter', 'requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains', 'domainType', 'isUrlFilterCaseSensitive'];
      const converted = Object.fromEntries(Object.entries(condition).filter(([key]) => supported.includes(key)));
      // WebView does not expose reliable resource types. Broader allowances
      // preserve compatibility rather than guessing and dropping exceptions.
      allowances.set(JSON.stringify(converted), converted);
    }
  }
  data[kind] = [...hosts].sort();
}
data.excludedRequests = [...exclusions].sort(); data.excludedInitiators = [...initiatorExclusions].sort();
data.allowances = [...allowances.values()];
await writeFile(path.join(assets, 'filters.json'), JSON.stringify(data));
for (const name of ['youtube-player.js', 'youtube-runtime.js']) {
  await copyFile(path.join(root, 'extension/content', name), path.join(assets, name));
}
await copyFile(path.join(root, 'extension/icons/icon128.png'), path.join(root, 'android/app/src/main/res/drawable/harbor_icon.png'));
await copyFile(path.join(root, 'extension/rules/LICENSE'), path.join(assets, 'FILTERS-LICENSE.txt'));
await copyFile(path.join(root, 'extension/rules/ATTRIBUTION.md'), path.join(assets, 'FILTERS-ATTRIBUTION.md'));
await copyFile(path.join(root, 'extension/rules/source-manifest.json'), path.join(assets, 'filter-source-manifest.json'));
await copyFile(path.join(root, 'LICENSE'), path.join(assets, 'SOURCE-LICENSE.txt'));
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(assets, 'SOURCE-NOTICES.md'));
const androidMetadata = { version: '0.2.2', sourceHelperVersion: '0.3.3', adDomains: data.ads.length,
  trackerDomains: data.trackers.length, networkAllowances: data.allowances.length,
  filtersSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  compatibility: 'Third-party host subset; resource-type exceptions are conservatively broadened.' };
await writeFile(path.join(assets, 'build-info.json'), JSON.stringify(androidMetadata, null, 2));
console.log(`Prepared HarborTube assets: ${data.ads.length} ad and ${data.trackers.length} tracker domains, ${data.allowances.length} compatibility allowances.`);
