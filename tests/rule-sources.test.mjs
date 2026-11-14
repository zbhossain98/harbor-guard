import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, DOMAIN_BATCH_SIZE, parseFilterSource, RESOURCE_TYPES, sha256, writeBatch } from '../scripts/update-rules.mjs';

const source = (lines) => `[Adblock Plus 2.0]\n! Version: 202601010000\n! Last modified: 01 Jan 2026 00:00 UTC\n${lines.join('\n')}\n`;
const custom = { ads: [], trackers: [] };

test('only pure hostname block filters enter the domain subset', () => {
  const parsed = parseFilterSource(source([
    '||ads.example^', '||track.example^$third-party', '||other.example^$3p',
    '||specific.example^$script', '||path.example/banner', '/banner.gif',
    'example.com##.advertisement', '||redirect.example^$redirect=noopjs',
    '||conditional.example^$domain=site.test', '||youtube.com^', '||r1.googlevideo.com^',
  ]));
  assert.deepEqual(parsed.hosts, ['ads.example', 'other.example', 'track.example']);
  assert.equal(parsed.report.protectedDomains, 2);
  assert.equal(parsed.version, '202601010000');
});

test('badfilter disables matching host filters without disabling unrelated options', () => {
  const parsed = parseFilterSource(source([
    '||disabled.example^', '||disabled.example^$badfilter',
    '||disabled3p.example^$third-party', '||disabled3p.example^$badfilter,third-party',
    '||active.example^$third-party',
  ]));
  assert.deepEqual(parsed.hosts, ['active.example']);
});

test('scoped network exceptions allow the required URL without exempting the whole site', () => {
  const parsed = parseFilterSource(source([
    '||ads.example^', '@@||ads.example/needed.js$script,domain=shop.example|~excluded.shop.example',
  ]));
  const compiled = compileRules(custom, { ads: parsed });
  assert.deepEqual(compiled.domains.ads, ['ads.example']);
  assert.equal(compiled.rules.ads[0].condition.excludedInitiatorDomains, undefined);
  const allow = compiled.rules.ads.find((rule) => rule.action.type === 'allow');
  assert.deepEqual(allow.condition.initiatorDomains, ['shop.example']);
  assert.equal(allow.condition.urlFilter, '||ads.example/needed.js');
  assert.ok(allow.priority > compiled.rules.ads[0].priority);
});

test('unsupported scoped regex exceptions retain a documented broad site fallback', () => {
  const parsed = parseFilterSource(source(['||ads.example^', '@@/^https?:.*required/$domain=shop.example']));
  assert.equal(parsed.report.broadScopedExceptions, 1);
  const compiled = compileRules(custom, { ads: parsed });
  assert.deepEqual(compiled.rules.ads[0].condition.excludedInitiatorDomains, ['shop.example']);
});

test('unscoped host exceptions conservatively exclude parent and child block domains', () => {
  const parsed = parseFilterSource(source([
    '||example.com^', '||ads.example.com^', '||other.test^', '@@||safe.example.com/required',
  ]));
  const compiled = compileRules(custom, { ads: parsed });
  assert.deepEqual(compiled.domains.ads, ['ads.example.com', 'other.test']);
  const parent = parseFilterSource(source(['||ads.example.com^', '@@||example.com^']));
  assert.deepEqual(compileRules(custom, { ads: parent }).domains.ads, []);
});

test('cosmetic exceptions cannot turn off network protection', () => {
  const parsed = parseFilterSource(source([
    '||ads.example^', '@@||ads.example^$generichide', '@@||ads.example^$elemhide',
  ]));
  assert.deepEqual(compileRules(custom, { ads: parsed }).domains.ads, ['ads.example']);
  assert.equal(parsed.report.ignoredCosmeticExceptions, 2);
});

test('frame-wide exceptions exempt initiators and generic URL exceptions use higher priority allow', () => {
  const parsed = parseFilterSource(source([
    '||ads.example^', '@@||shop.example^$document', '@@/required-library.js$script',
  ]));
  const compiled = compileRules(custom, { ads: parsed });
  assert.deepEqual(compiled.rules.ads[0].condition.excludedInitiatorDomains, ['shop.example']);
  const allow = compiled.rules.ads.find((rule) => rule.action.type === 'allow');
  assert.equal(allow.condition.urlFilter, '/required-library.js');
  assert.ok(allow.priority > compiled.rules.ads[0].priority);
  assert.deepEqual(allow.condition.resourceTypes, RESOURCE_TYPES);
});

test('unsupported global network exceptions fail closed before rules are generated', () => {
  assert.throws(() => parseFilterSource(source(['||ads.example^', '@@/^https?:.*required/'])), /cannot be preserved safely/);
  assert.throws(() => parseFilterSource(source(['@@/path$document'])), /cannot be preserved safely/);
  assert.throws(() => parseFilterSource(source(['@@*$domain=example.*'])), /cannot be preserved safely/);
  assert.throws(() => parseFilterSource(source(['@@|https://$sitekey=unverified'])), /cannot be preserved safely/);
  assert.throws(() => parseFilterSource('<html>unexpected</html>'), /expected an Adblock Plus/);
  assert.deepEqual(parseFilterSource(`\uFEFF${source(['||ads.example^'])}`).hosts, ['ads.example']);
});

test('large maintained lists compile within the guaranteed static rule minimum', () => {
  const hosts = Array.from({ length: 31001 }, (_, index) => `ad${index}.example`);
  const parsed = { hosts, excludedRequestDomains: [], excludedInitiatorDomains: [], allowPatterns: [], report: {} };
  const compiled = compileRules(custom, { ads: parsed });
  assert.equal(compiled.domainCounts.ads, 31001);
  assert.equal(compiled.ruleCounts.ads, Math.ceil(31001 / DOMAIN_BATCH_SIZE));
  assert.ok(compiled.rules.ads.every((rule) => rule.condition.requestDomains.length <= DOMAIN_BATCH_SIZE));
  assert.ok(compiled.rules.ads.every((rule) => !rule.condition.resourceTypes.includes('main_frame')));
  assert.ok(compiled.rules.ads.every((rule) => rule.condition.domainType === 'thirdParty'));
});

test('source exceptions apply across categories and local hosts cannot bypass them', () => {
  const parsed = parseFilterSource(source(['@@||exempt.example^']));
  const compiled = compileRules({ ads: ['exempt.example', 'ad.example'], trackers: ['track.example'] }, { trackers: parsed });
  assert.deepEqual(compiled.domains.ads, ['ad.example']);
  assert.deepEqual(compiled.domains.trackers, ['track.example']);
  assert.throws(() => compileRules({ ads: ['googlevideo.com'], trackers: [] }), /protected service/);
});

test('snapshot hash is deterministic and changes when source bytes change', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(sha256('abc'), sha256('abc\n'));
});

function memoryFiles(initial, failCommitTo = null, failStage = false) {
  const files = new Map(Object.entries(initial));
  let failed = false;
  const io = {
    async readFile(path) {
      if (!files.has(path.href)) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
      return files.get(path.href);
    },
    async writeFile(path, contents, options) {
      if (failStage && path.href.endsWith('.bak')) throw new Error('Simulated staging failure');
      if (options?.flag === 'wx' && files.has(path.href)) throw new Error('File already exists');
      files.set(path.href, contents);
    },
    async rename(from, to) {
      if (!failed && to.href === failCommitTo && from.href.endsWith('.tmp')) {
        failed = true;
        throw new Error('Simulated commit failure');
      }
      if (!files.has(from.href)) throw new Error('Missing staged file');
      files.set(to.href, files.get(from.href));
      files.delete(from.href);
    },
    async rm(path) { files.delete(path.href); },
  };
  return { files, io };
}

test('staging failure leaves all existing snapshots and generated rules untouched', async () => {
  const initial = { 'file:///source.txt': 'old-source', 'file:///rules.json': 'old-rules' };
  const { files, io } = memoryFiles(initial, null, true);
  await assert.rejects(writeBatch([
    [new URL('file:///source.txt'), 'new-source'], [new URL('file:///rules.json'), 'new-rules'],
  ], io), /staging failure/);
  assert.deepEqual(Object.fromEntries(files), initial);
});

test('commit failure restores earlier files and removes newly created outputs', async () => {
  const initial = { 'file:///source.txt': 'old-source', 'file:///rules.json': 'old-rules' };
  const { files, io } = memoryFiles(initial, 'file:///rules.json');
  await assert.rejects(writeBatch([
    [new URL('file:///source.txt'), 'new-source'], [new URL('file:///new-file.json'), 'new'],
    [new URL('file:///rules.json'), 'new-rules'],
  ], io), /commit failure/);
  assert.deepEqual(Object.fromEntries(files), initial);
});

test('successful batch replacement leaves only the intended source and output files', async () => {
  const { files, io } = memoryFiles({ 'file:///source.txt': 'old-source' });
  await writeBatch([
    [new URL('file:///source.txt'), 'new-source'], [new URL('file:///rules.json'), 'new-rules'],
  ], io);
  assert.deepEqual(Object.fromEntries(files), { 'file:///source.txt': 'new-source', 'file:///rules.json': 'new-rules' });
});
