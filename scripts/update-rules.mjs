import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeHostname } from '../extension/lib/settings.js';
import { get as httpsGet } from 'node:https';

const root = new URL('../', import.meta.url);
const rulesDirectory = new URL('extension/rules/', root);
const snapshotDirectory = new URL('data/filter-sources/', root);
export const SOURCE_URLS = Object.freeze({
  ads: 'https://easylist.to/easylist/easylist.txt',
  trackers: 'https://easylist.to/easylist/easyprivacy.txt',
  // EasyList offers CC BY-SA 3.0 or GPLv3: https://easylist.to/pages/licence.html
  // This build distributes the adapted filter data under CC BY-SA 3.0.
  license: 'https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt',
});
const SOURCE_FILES = { ads: 'easylist.txt', trackers: 'easyprivacy.txt', license: 'LICENSE' };
export const RESOURCE_TYPES = Object.freeze([
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
]);
export const DOMAIN_BATCH_SIZE = 500;
const MAX_STATIC_RULES = 30000;
const ROOTS_TO_PRESERVE = ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com',
  'google.com', 'facebook.com', 'bing.com', 'microsoft.com', 'apple.com', 'amazon.com'];
const MEDIA_SUFFIXES_TO_PRESERVE = ['googlevideo.com', 'ytimg.com', 'youtube-nocookie.com'];
const COSMETIC_OPTIONS = new Set(['elemhide', 'generichide', 'specifichide', 'ehide', 'ghide', 'shide', 'csp', 'removeparam', 'urltransform', 'cookie']);

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function overlap(a, b) { return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`); }
function sorted(values) { return [...new Set(values)].sort(); }
function protectedDomain(domain) {
  return ROOTS_TO_PRESERVE.some((site) => domain === site || site.endsWith(`.${domain}`))
    || MEDIA_SUFFIXES_TO_PRESERVE.some((site) => domain.endsWith(`.${site}`));
}

function splitFilter(line) {
  let split = line.lastIndexOf('$');
  if (line.startsWith('/')) {
    const lastSlash = line.lastIndexOf('/');
    if (lastSlash > 0 && (lastSlash === line.length - 1 || line[lastSlash + 1] !== '$')) split = -1;
  }
  return split < 0 ? { pattern: line, options: [] }
    : { pattern: line.slice(0, split), options: line.slice(split + 1).split(',').filter(Boolean) };
}

function canonicalFilter(line) {
  const { pattern, options } = splitFilter(line);
  const active = options.filter((option) => option !== 'badfilter').sort();
  return `${pattern}${active.length ? `$${active.join(',')}` : ''}`;
}

function exceptionRequestHost(pattern) {
  const match = pattern.match(/^\|\|([a-z0-9.-]+)(?:[\^/|]|$)/i)
    || pattern.match(/^\|?https?:\/\/([a-z0-9.-]+)(?:[\^/:|]|$)/i);
  return match ? normalizeHostname(match[1]) : null;
}

function optionName(option) { return option.replace(/^~/, '').split('=')[0]; }

function basicUrlPattern(pattern, scoped = false) {
  const literal = pattern.replace(/^\|?https?\*?:\/\//i, '').replace(/[|^*]/g, '');
  return !(pattern.startsWith('/') && pattern.endsWith('/'))
    && pattern.length > 0 && pattern.length <= 2000 && !/[^\x20-\x7e]/.test(pattern)
    && (literal.length >= 2 || scoped && pattern === '*');
}

/** Parse only host blocking. Exception parsing is deliberately broader to avoid overblocking. */
export function parseFilterSource(text, name = 'filter source') {
  if (typeof text !== 'string' || !/^\uFEFF?\[Adblock Plus /m.test(text)) throw new Error(`${name}: expected an Adblock Plus filter list.`);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
  const disabled = new Set(lines.filter((line) => splitFilter(line).options.includes('badfilter')).map(canonicalFilter));
  const hosts = new Set();
  const excludedRequestDomains = new Set();
  const excludedInitiatorDomains = new Set();
  const allowPatterns = new Set();
  const allowConditions = [];
  const report = { hostFilters: 0, exceptionFilters: 0, scopedExceptions: 0, hostExceptions: 0, urlExceptions: 0,
    broadScopedExceptions: 0, ignoredCosmeticExceptions: 0, disabledFilters: 0, skippedBlockFilters: 0, protectedDomains: 0 };
  const unsupportedExceptions = [];

  for (const line of lines) {
    if (!line || line.startsWith('!') || line.startsWith('[') || /#[@?$%]?#/.test(line)) continue;
    const exception = line.startsWith('@@');
    const filter = exception ? line.slice(2) : line;
    const { pattern, options } = splitFilter(filter);
    if (options.includes('badfilter') || disabled.has(canonicalFilter(line))) { report.disabledFilters += 1; continue; }
    if (!exception) {
      const match = pattern.match(/^\|\|([a-z0-9.-]+)\^$/i);
      const host = match && normalizeHostname(match[1]);
      if (!host || !host.includes('.') || host !== match[1].toLowerCase()
        || options.some((option) => !['third-party', '3p'].includes(option))) {
        report.skippedBlockFilters += 1;
        continue;
      }
      if (protectedDomain(host)) { report.protectedDomains += 1; continue; }
      hosts.add(host);
      report.hostFilters += 1;
      continue;
    }

    report.exceptionFilters += 1;
    const names = options.map(optionName);
    const nonContextNames = names.filter((option) => !['domain', 'sitekey', 'third-party', '3p', 'match-case'].includes(option));
    if (nonContextNames.length && nonContextNames.every((option) => COSMETIC_OPTIONS.has(option))) {
      report.ignoredCosmeticExceptions += 1;
      continue;
    }
    const domainOption = options.find((option) => option.startsWith('domain='));
    const scopes = (domainOption?.slice(7).split('|') || []).filter((domain) => !domain.startsWith('~'));
    const canonicalScopes = scopes.map(normalizeHostname);
    if (scopes.length && canonicalScopes.every(Boolean)) {
      const frameWide = names.some((option) => ['document', 'doc', 'genericblock'].includes(option));
      if (!frameWide && basicUrlPattern(pattern, true)) {
        allowConditions.push({ urlFilter: pattern, initiatorDomains: sorted(canonicalScopes), resourceTypes: [...RESOURCE_TYPES] });
      } else {
        canonicalScopes.forEach((domain) => excludedInitiatorDomains.add(domain));
        report.broadScopedExceptions += 1;
      }
      report.scopedExceptions += 1;
      continue;
    }
    const host = exceptionRequestHost(pattern);
    if (host) {
      excludedRequestDomains.add(host);
      if (names.some((option) => ['document', 'doc', 'genericblock'].includes(option))) excludedInitiatorDomains.add(host);
      report.hostExceptions += 1;
      continue;
    }
    // Frame-wide exceptions cannot be approximated by an individual resource allowance.
    if (names.some((option) => ['document', 'doc', 'genericblock'].includes(option))
      || !basicUrlPattern(pattern)) {
      unsupportedExceptions.push(line);
      continue;
    }
    // DNR urlFilter supports the same basic |, ||, *, and ^ URL pattern tokens.
    // Dropping resource-type and context restrictions broadens allowances, never blocks more.
    allowPatterns.add(pattern);
    report.urlExceptions += 1;
  }
  if (unsupportedExceptions.length) {
    throw new Error(`${name}: ${unsupportedExceptions.length} network exception(s) cannot be preserved safely. Review the converter before rebuilding.\n${unsupportedExceptions.slice(0, 8).join('\n')}`);
  }
  return {
    hosts: sorted(hosts), excludedRequestDomains: sorted(excludedRequestDomains),
    excludedInitiatorDomains: sorted(excludedInitiatorDomains), allowPatterns: sorted(allowPatterns), allowConditions, report,
    version: lines.find((line) => /^! Version:/i.test(line))?.replace(/^! Version:\s*/i, '') || null,
    lastModified: lines.find((line) => /^! Last modified:/i.test(line))?.replace(/^! Last modified:\s*/i, '') || null,
  };
}

function validateCustomHosts(custom) {
  const seen = new Set();
  return Object.fromEntries(['ads', 'trackers'].map((category) => {
    if (!Array.isArray(custom[category])) throw new Error(`Missing custom host list: ${category}`);
    return [category, custom[category].map((host) => {
      if (normalizeHostname(host) !== host || !host.includes('.')) throw new Error(`Invalid canonical custom host: ${host}`);
      if (seen.has(host)) throw new Error(`Duplicate custom host: ${host}`);
      if (protectedDomain(host)) throw new Error(`Custom host would block a protected service root: ${host}`);
      seen.add(host);
      return host;
    })];
  }));
}

export function compileRules(custom, parsedSources = {}) {
  const customHosts = validateCustomHosts(custom);
  const sourceEntries = Object.values(parsedSources);
  // Cross-category exceptions avoid enabling a second category that breaks an allowed integration.
  const excludedRequestDomains = sorted(sourceEntries.flatMap((source) => source.excludedRequestDomains));
  const excludedInitiatorDomains = sorted(sourceEntries.flatMap((source) => source.excludedInitiatorDomains));
  const allowPatterns = sorted(sourceEntries.flatMap((source) => source.allowPatterns));
  const allowConditions = sorted([
    ...sourceEntries.flatMap((source) => source.allowConditions || []),
    ...allowPatterns.map((urlFilter) => ({ urlFilter, resourceTypes: [...RESOURCE_TYPES] })),
  ].map((condition) => JSON.stringify(condition))).map((condition) => JSON.parse(condition));
  const domains = {};
  const rules = {};
  const report = {};
  const trackerOverrides = new Set([...(parsedSources.trackers?.hosts || []), ...customHosts.trackers]);
  for (const category of ['ads', 'trackers']) {
    const candidates = sorted([...(parsedSources[category]?.hosts || []), ...customHosts[category]]);
    let safe = candidates.filter((host) => !protectedDomain(host)
      && !excludedRequestDomains.some((exception) => overlap(host, exception)));
    if (category === 'ads') safe = safe.filter((host) => !trackerOverrides.has(host));
    domains[category] = safe;
    report[category] = { ...(parsedSources[category]?.report || {}), candidateDomains: candidates.length,
      compiledDomains: safe.length, excludedDomains: candidates.length - safe.length };
    const categoryRules = [];
    for (let offset = 0; offset < safe.length; offset += DOMAIN_BATCH_SIZE) {
      categoryRules.push({
        id: categoryRules.length + 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          requestDomains: safe.slice(offset, offset + DOMAIN_BATCH_SIZE),
          domainType: 'thirdParty',
          resourceTypes: [...RESOURCE_TYPES],
          ...(excludedInitiatorDomains.length ? { excludedInitiatorDomains } : {}),
        },
      });
    }
    for (const condition of allowConditions) {
      categoryRules.push({ id: 50000 + categoryRules.length, priority: 2,
        action: { type: 'allow' }, condition });
    }
    rules[category] = categoryRules;
  }
  const ruleCounts = Object.fromEntries(Object.entries(rules).map(([category, value]) => [category, value.length]));
  const domainCounts = Object.fromEntries(Object.entries(domains).map(([category, value]) => [category, value.length]));
  if (Object.values(ruleCounts).reduce((a, b) => a + b, 0) > MAX_STATIC_RULES) throw new Error('Compiled rules exceed the 30,000-rule static minimum.');
  return { rules, domains, ruleCounts, domainCounts,
    report: { categories: report, excludedRequestDomains: excludedRequestDomains.length,
      excludedInitiatorDomains: excludedInitiatorDomains.length, supplementalAllowRulesPerCategory: allowConditions.length } };
}

/** Stage every file first, then roll back ordinary commit failures. No recursive file operations. */
export async function writeBatch(entries, io = { readFile, writeFile, rename, rm }) {
  const token = randomUUID();
  const staged = [];
  let committed = 0;
  let keepBackups = false;
  try {
    for (const [destination, contents] of entries) {
      const temporary = new URL(`${destination.href}.harbor-${token}.tmp`);
      const backup = new URL(`${destination.href}.harbor-${token}.bak`);
      const previous = await io.readFile(destination).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const item = { destination, temporary, backup, existed: previous !== null };
      staged.push(item);
      await io.writeFile(temporary, contents, { flag: 'wx' });
      if (item.existed) await io.writeFile(backup, previous, { flag: 'wx' });
    }
    for (const item of staged) { await io.rename(item.temporary, item.destination); committed += 1; }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of staged.slice(0, committed).reverse()) {
      try {
        if (item.existed) await io.rename(item.backup, item.destination);
        else await io.rm(item.destination, { force: true });
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      keepBackups = true;
      throw new AggregateError([error, ...rollbackErrors], 'Import failed and rollback needs attention. Preserved .harbor-*.bak files contain the previous data.');
    }
    throw error;
  } finally {
    for (const item of staged) {
      await io.rm(item.temporary, { force: true }).catch(() => {});
      if (!keepBackups) await io.rm(item.backup, { force: true }).catch(() => {});
    }
  }
}

function downloadBytes(url, redirects = 0) {
  // Use Node's HTTPS client: some Node 24 fetch builds crash while consuming
  // these large responses through a proxy, before a catch can handle the error.
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, (response) => {
      response.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) return reject(new Error(`${url}: invalid redirect.`));
        const target = new URL(response.headers.location, url);
        if (target.protocol !== 'https:') return reject(new Error(`${url}: insecure redirect refused.`));
        resolve(downloadBytes(target.href, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`${url}: HTTP ${response.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return response.destroy(new Error(`${url}: unexpected source size.`));
        chunks.push(chunk);
      });
      response.on('end', () => size ? resolve(Buffer.concat(chunks)) : reject(new Error(`${url}: empty source.`)));
    });
    request.setTimeout(30000, () => request.destroy(new Error(`${url}: download timed out.`)));
    request.on('error', reject);
  });
}

async function downloadSources() {
  const results = await Promise.allSettled(Object.entries(SOURCE_URLS).map(async ([category, url]) => {
    const bytes = await downloadBytes(url);
    return { category, url, bytes };
  }));
  const failures = results.filter((item) => item.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((item) => item.reason), failures.map((item) => item.reason.message).join('\n'));
  const fetched = results.map((item) => item.value);
  fetched.filter(({ category }) => category !== 'license').forEach(({ category, bytes }) => {
    const parsed = parseFilterSource(bytes.toString('utf8'), category);
    if (parsed.hosts.length < 1000) throw new Error(`${category}: unexpectedly small source subset; review the upstream response.`);
  });
  const license = fetched.find(({ category }) => category === 'license').bytes.toString('utf8');
  if (!/GNU GENERAL PUBLIC LICENSE|GPL|Creative Commons/i.test(license)) throw new Error('Upstream license requires manual review.');
  const previousLicense = await readFile(new URL('LICENSE', snapshotDirectory), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previousLicense !== null && sha256(previousLicense) !== sha256(license)) {
    throw new Error('Upstream license changed. Review its terms before replacing the existing source snapshots.');
  }
  const acquisition = `${JSON.stringify({
    downloadedAt: new Date().toISOString(),
    files: fetched.map(({ category, url, bytes }) => ({ file: SOURCE_FILES[category], url, sha256: sha256(bytes) })),
  }, null, 2)}\n`;
  return { fetched, acquisition };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--check', '--download'].includes(arg)) || args.includes('--check') && args.includes('--download')) {
    throw new Error('Usage: node scripts/update-rules.mjs [--check | --download]');
  }
  const custom = JSON.parse(await readFile(new URL('hosts.json', rulesDirectory), 'utf8'));
  validateCustomHosts(custom);
  const downloaded = args.includes('--download') ? await downloadSources() : null;
  const parsed = {};
  const sources = [];
  for (const category of ['ads', 'trackers']) {
    const snapshot = downloaded?.fetched.find((item) => item.category === category).bytes
      ?? await readFile(new URL(SOURCE_FILES[category], snapshotDirectory)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!snapshot) continue;
    parsed[category] = parseFilterSource(snapshot.toString('utf8'), SOURCE_FILES[category]);
    sources.push({ category, url: SOURCE_URLS[category], snapshot: `data/filter-sources/${SOURCE_FILES[category]}`,
      sha256: sha256(snapshot), version: parsed[category].version, lastModified: parsed[category].lastModified });
  }
  if (sources.length === 1) throw new Error('Both EasyList and EasyPrivacy snapshots are required.');
  const previousManifest = await readFile(new URL('source-manifest.json', rulesDirectory), 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!sources.length && previousManifest?.coverageMode === 'maintained-domain-subset') {
    throw new Error('The bundled maintained rules require their raw EasyList/EasyPrivacy source snapshots. Restore data/filter-sources before rebuilding.');
  }
  let license = null;
  let licenseText = null;
  if (sources.length) {
    const bytes = downloaded?.fetched.find((item) => item.category === 'license').bytes
      ?? await readFile(new URL('LICENSE', snapshotDirectory));
    if (bytes.length < 100 || !/GNU GENERAL PUBLIC LICENSE|GPL|Creative Commons/i.test(bytes.toString('utf8'))) {
      throw new Error('The upstream LICENSE snapshot is missing recognizable license terms; review the manual snapshot before importing.');
    }
    licenseText = bytes.toString('utf8');
    license = { name: 'CC BY-SA 3.0 Unported', authors: 'The EasyList authors (https://easylist.to/)',
      snapshot: 'data/filter-sources/LICENSE', bundled: 'extension/rules/LICENSE',
      url: SOURCE_URLS.license, sha256: sha256(bytes) };
  }
  const compiled = compileRules(custom, parsed);
  if (!sources.length) {
    // Preserve the original 48-rule starter build until real source snapshots exist.
    // No maintained-list coverage is implied by installing the converter alone.
    for (const [index, category] of ['ads', 'trackers'].entries()) {
      compiled.rules[category] = compiled.domains[category].map((host, position) => ({
        id: index * 1000 + position + 1, priority: 1, action: { type: 'block' },
        condition: { urlFilter: `||${host}^`, domainType: 'thirdParty', resourceTypes: [...RESOURCE_TYPES] },
      }));
      compiled.ruleCounts[category] = compiled.rules[category].length;
    }
  }
  const outputs = ['ads', 'trackers'].map((category) => [`${category}.json`, `${JSON.stringify(compiled.rules[category], null, 2)}\n`]);
  if (licenseText !== null) outputs.push(['LICENSE', licenseText]);
  outputs.push(['catalog.js', `// Generated by scripts/update-rules.mjs.\nexport const RULESET_COUNTS = Object.freeze(${JSON.stringify(compiled.ruleCounts, null, 2)});\nexport const DOMAIN_COUNTS = Object.freeze(${JSON.stringify(compiled.domainCounts, null, 2)});\n`]);
  outputs.push(['source-manifest.json', `${JSON.stringify({
    formatVersion: 1, coverageMode: sources.length ? 'maintained-domain-subset' : 'local-starter',
    sources, license, localSource: 'extension/rules/hosts.json',
    localSourceSha256: sha256(await readFile(new URL('hosts.json', rulesDirectory))),
    domainBatchSize: DOMAIN_BATCH_SIZE, domainCounts: compiled.domainCounts,
    ruleCounts: compiled.ruleCounts, conversion: compiled.report,
  }, null, 2)}\n`]);
  const check = args.includes('--check');
  for (const [name, contents] of outputs) {
    const destination = new URL(name, rulesDirectory);
    if (check) {
      const current = await readFile(destination, 'utf8').catch(() => '');
      if (current !== contents) throw new Error(`Bundled rules are out of date: ${fileURLToPath(destination)}`);
    }
  }
  if (!check) {
    const entries = outputs.map(([name, contents]) => [new URL(name, rulesDirectory), contents]);
    if (downloaded) {
      await mkdir(snapshotDirectory, { recursive: true });
      entries.unshift(...downloaded.fetched.map(({ category, bytes }) => [new URL(SOURCE_FILES[category], snapshotDirectory), bytes]),
        [new URL('acquisition.json', snapshotDirectory), downloaded.acquisition]);
    }
    await writeBatch(entries);
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${compiled.domainCounts.ads} ad domains and ${compiled.domainCounts.trackers} tracker domains in ${compiled.ruleCounts.ads + compiled.ruleCounts.trackers} static rules (${sources.length ? 'EasyList/EasyPrivacy snapshots + local entries' : 'local entries only; upstream snapshots absent'}).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
