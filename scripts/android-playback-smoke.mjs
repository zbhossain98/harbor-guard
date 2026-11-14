import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Controlled desktop Chromium playback test, not an Android device benchmark.
// A canvas supplies local frames. All network requests receive local fixtures.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HARBOR_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.cache'), { recursive: true });
const profile = await mkdtemp(path.join(root, '.cache', 'android-playback-smoke-'));
const assets = path.join(root, 'android/app/src/main/assets');
const sources = await Promise.all(['youtube-runtime.js', 'youtube-player.js', 'youtube-dom.js', 'harbortube-media.js'].map(name => readFile(path.join(assets, name), 'utf8')));
const baseline = process.env.HARBOR_BASELINE_DIR;
const fixture = `<!doctype html><meta charset="utf-8"><title>Playback fixture - YouTube</title>
<style>body{margin:0}video{width:100%;height:200px}canvas{display:none}</style>
<div id="movie_player"><video autoplay muted playsinline></video></div><div id="feed"></div><canvas width="320" height="180"></canvas>
<script>
window.reads=0;window.frames=0;window.scans=0;window.nativeMessages=[];
const response={videoDetails:{videoId:'abcdefghijk',title:'Playback fixture'},streamingData:{formats:[{itag:18,url:'https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=18',height:360,mimeType:'video/mp4; codecs="avc1, mp4a"',audioQuality:'AUDIO_QUALITY_MEDIUM'}]}};
document.querySelector('#movie_player').getPlayerResponse=()=>{window.reads++;return JSON.parse(JSON.stringify(response));};
const scan=document.querySelectorAll.bind(document);document.querySelectorAll=(selector)=>{window.scans++;return scan(selector);};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),video=document.querySelector('video');
video.srcObject=canvas.captureStream(24);window.started=video.play();
function draw(t){ctx.fillStyle='hsl('+Math.round(t/20)%360+',60%,50%)';ctx.fillRect(0,0,320,180);requestAnimationFrame(draw);}requestAnimationFrame(draw);
function frame(){window.frames++;video.requestVideoFrameCallback(frame);}video.requestVideoFrameCallback(frame);
let n=0;setInterval(()=>{const node=document.createElement('div');node.textContent='Recommendation '+n++;document.querySelector('#feed').appendChild(node);if(n%5===0){const ad=document.createElement('ytm-ad-slot-renderer');ad.textContent='Ad fixture';document.querySelector('#feed').appendChild(ad);}},40);
</script>`;
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.HARBOR_BROWSER_PATH ? { executablePath: process.env.HARBOR_BROWSER_PATH } : { channel: 'msedge' }),
  headless: true, viewport: { width: 390, height: 844 },
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-networking']
});
const errors = [], results = {};
await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
async function run(label, scripts) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(`window.__harborGuardYouTubeEnabled=true;window.harborTube={postMessage(value){if(window.nativeMessages)window.nativeMessages.push(JSON.parse(value));}};\n${scripts.join('\n')}`);
  await page.goto('https://m.youtube.com/watch?v=abcdefghijk');
  await page.waitForFunction(() => document.querySelector('video').currentTime > 4, undefined, { timeout: 15000 });
  const metrics = await page.evaluate(() => {
    const video = document.querySelector('video'), quality = video.getVideoPlaybackQuality();
    return { currentTime: video.currentTime, paused: video.paused, frames: window.frames, reads: window.reads,
      documentScans: window.scans, messages: window.nativeMessages.length, dropped: quality.droppedVideoFrames,
      slotsHidden: [...document.getElementsByTagName('ytm-ad-slot-renderer')].every(node => getComputedStyle(node).display === 'none') };
  });
  assert.equal(metrics.paused, false); assert.ok(metrics.frames > 10); assert.equal(metrics.slotsHidden, true);
  results[label] = metrics; await page.close();
}
try {
  if (baseline) await run('v0_2_1', [sources[0], sources[1], await readFile(path.join(baseline, 'youtube-dom.js'), 'utf8'), await readFile(path.join(baseline, 'harbortube-media.js'), 'utf8')]);
  await run('v0_2_2', sources);
  assert.equal(results.v0_2_2.documentScans, 0);
  assert.ok(results.v0_2_2.reads <= 2, 'ordinary playback must not poll player response metadata');
  if (baseline) {
    assert.ok(results.v0_2_1.documentScans > results.v0_2_2.documentScans);
    assert.ok(results.v0_2_1.reads > results.v0_2_2.reads);
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, '.cache/android-playback-smoke-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log('Controlled desktop playback and dynamic ad-slot checks passed; phone smoothness remains unmeasured.');
} finally { await context.close(); }
