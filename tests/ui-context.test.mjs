import test from 'node:test';
import assert from 'node:assert/strict';
import { siteContext } from '../extension/ui/client.js';

test('site controls accept regular http(s) pages without retaining the URL', () => {
  assert.deepEqual(siteContext('https://news.example.com/private?q=secret'), { hostname: 'news.example.com', reason: '' });
  assert.deepEqual(siteContext('http://localhost:8123/'), { hostname: 'localhost', reason: '' });
  assert.deepEqual(siteContext('https://example.com./page'), { hostname: 'example.com', reason: '' });
});
test('browser pages, malformed URLs, and extension stores do not expose a site toggle', () => {
  for (const url of [undefined, '', 'bad-url', 'http://[::1]/', 'chrome://extensions', 'edge://settings', 'about:blank', 'file:///C:/test.html', 'chrome-extension://abc/dashboard.html', 'https://chromewebstore.google.com/detail/example', 'https://chromewebstore.google.com./detail/example', 'https://chrome.google.com/webstore/detail/test', 'https://microsoftedge.microsoft.com/addons/detail/test']) {
    const context = siteContext(url);
    assert.equal(context.hostname, '', String(url));
    assert.ok(context.reason.length > 0);
  }
});
test('store guards use exact host and path boundaries', () => {
  assert.equal(siteContext('https://chromewebstore.google.com.example.com/').hostname, 'chromewebstore.google.com.example.com');
  assert.equal(siteContext('https://chrome.google.com/webstore-not-a-store').hostname, 'chrome.google.com');
  assert.equal(siteContext('https://microsoftedge.microsoft.com/other').hostname, 'microsoftedge.microsoft.com');
});
