import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { YOUTUBE_SCRIPT_FILES } from '../extension/lib/youtube.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ext = path.join(root, 'extension');
const readJSON = async (relative) => JSON.parse(await readFile(path.join(ext, relative), 'utf8'));
const manifest = await readJSON('manifest.json');
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'declarativeNetRequest', 'storage', 'scripting'].sort());
const refs = [...YOUTUBE_SCRIPT_FILES, manifest.background.service_worker, manifest.options_page, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])])];
for (const name of refs) assert.ok((await readFile(path.join(ext, name))).length, `${name} is empty`);
for (const resource of manifest.declarative_net_request.rule_resources) {
  const rules = await readJSON(resource.path);
  assert.ok(rules.length > 0, `${resource.id} has no rules`);
  const ids = new Set();
  for (const rule of rules) {
    assert.ok(Number.isInteger(rule.id) && rule.id > 0 && !ids.has(rule.id), `Invalid/duplicate rule in ${resource.id}`);
    ids.add(rule.id);
    assert.ok(['block', 'allow'].includes(rule.action.type), 'Unexpected rule action');
    if (rule.action.type === 'allow') assert.ok(rule.priority > 1, 'Compatibility exceptions must override blocking rules');
    assert.ok(rule.condition && (rule.condition.urlFilter || rule.condition.requestDomains), 'Missing rule condition');
    assert.ok(!rule.condition.resourceTypes?.includes('main_frame'), 'Ad/tracker rules must not block top-level navigation');
  }
  console.log(`${resource.id}: ${rules.length} valid static rules`);
}
async function walk(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map((item) => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]))).flat();
}
const files = await walk(ext);
for (const file of files.filter((name) => /\.(js|mjs)$/.test(name))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
for (const file of files.filter((name) => name.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'No inline JavaScript permitted');
  assert.ok(!/\son\w+\s*=/i.test(html), 'No inline event handlers permitted');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(?:https?:|#)/.test(ref)) continue;
    await readFile(path.resolve(path.dirname(file), ref.split('#')[0]));
  }
}
console.log(`Manifest, referenced assets, and ${files.filter((f) => /\.(js|mjs)$/.test(f)).length} JavaScript files checked.`);
