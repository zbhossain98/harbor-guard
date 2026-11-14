import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, cp, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.cache', 'android-toolchain');
const offline = process.argv.includes('--offline');
await mkdir(cache, { recursive: true });
let apacheLicense;
if (offline) apacheLicense = await readFile(path.join(root, 'android/app/src/main/assets/ANDROIDX-LICENSE.txt'));
else {
  const apacheResponse = await response('https://www.apache.org/licenses/LICENSE-2.0.txt');
  const apacheChunks = []; for await (const chunk of apacheResponse) apacheChunks.push(chunk);
  apacheLicense = Buffer.concat(apacheChunks);
}
if (!apacheLicense.toString('utf8').includes('Apache License') || apacheLicense.length < 10000) throw new Error('Invalid Apache license response');
await writeFile(path.join(root, 'android/app/src/main/assets/ANDROIDX-LICENSE.txt'), apacheLicense);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
function ps(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Android toolchain command failed.');
}
function response(url, redirects = 0) {
  if (offline) throw new Error(`Offline setup cannot download ${url}`);
  return new Promise((resolve, reject) => {
    const request = get(url, (result) => {
      result.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
        result.resume();
        if (redirects >= 6 || !result.headers.location) return reject(new Error('Invalid tool download redirect'));
        const next = new URL(result.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Insecure tool download refused'));
        resolve(response(next.href, redirects + 1)); return;
      }
      if (result.statusCode !== 200) { result.resume(); return reject(new Error(`${url}: HTTP ${result.statusCode}`)); }
      resolve(result);
    });
    request.setTimeout(60000, () => request.destroy(new Error('Tool download timed out')));
    request.on('error', reject);
  });
}
async function artifact(name, url, checksum, algorithm = 'sha256') {
  const destination = path.join(cache, name);
  const existing = await readFile(destination).catch(() => null);
  if (existing && createHash(algorithm).update(existing).digest('hex') === checksum) {
    console.log(`Using verified ${name}`); return destination;
  }
  console.log(`Downloading ${name}…`);
  const source = await response(url);
  let downloaded = 0, reported = 0;
  source.on('data', (chunk) => {
    downloaded += chunk.length;
    if (downloaded - reported > 25 * 1024 * 1024) {
      reported = downloaded; console.log(`${name}: ${Math.round(downloaded / 1024 / 1024)} MiB received`);
    }
  });
  const temporary = destination + '.part';
  await pipeline(source, createWriteStream(temporary));
  const bytes = await readFile(temporary);
  if (createHash(algorithm).update(bytes).digest('hex') !== checksum) throw new Error(`${name}: upstream checksum mismatch`);
  await rename(temporary, destination);
  console.log(`Verified ${name}`); return destination;
}
async function extract(archive, name) {
  const destination = path.join(cache, name);
  const marker = path.join(destination, '.complete');
  if (await readFile(marker).catch(() => null)) return destination;
  await mkdir(destination, { recursive: true });
  console.log(`Extracting ${name}…`);
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$extractRoot = [IO.Path]::GetFullPath(${quote(destination)})
$extractZip = [IO.Compression.ZipFile]::OpenRead(${quote(archive)})
try {
  foreach ($extractEntry in $extractZip.Entries) {
    $extractTarget = [IO.Path]::GetFullPath([IO.Path]::Combine($extractRoot, $extractEntry.FullName))
    if (-not $extractTarget.StartsWith($extractRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry outside extraction directory' }
    if ($extractEntry.Name.Length -eq 0) { [IO.Directory]::CreateDirectory($extractTarget) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($extractTarget)) | Out-Null
    $extractInput = $extractEntry.Open()
    try { $extractOutput = [IO.File]::Create($extractTarget); try { $extractInput.CopyTo($extractOutput) } finally { $extractOutput.Dispose() } } finally { $extractInput.Dispose() }
  }
} finally { $extractZip.Dispose() }`);
  await writeFile(marker, 'Archive checksum verified before extraction.\n');
  return destination;
}
async function packageRoot(directory, marker) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const candidate = path.join(directory, item.name);
    if (await readFile(path.join(candidate, marker)).catch(() => null)) return candidate;
  }
  throw new Error(`Extracted tool is missing ${marker}`);
}

// Pinned from Adoptium's official package metadata; no system installation.
const javaZip = await artifact('jdk17.zip', 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip',
  'e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0');
const javaHome = await packageRoot(await extract(javaZip, 'jdk'), 'bin/java.exe');
let gradleHome;
if (offline) {
  await readFile(path.join(cache, 'gradle', '.complete')); // Previous checksum-verified extraction only.
  gradleHome = await packageRoot(path.join(cache, 'gradle'), 'bin/gradle.bat');
} else {
  const gradleChecksumResponse = await response('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  const checksumChunks = []; for await (const chunk of gradleChecksumResponse) checksumChunks.push(chunk);
  const gradleChecksum = Buffer.concat(checksumChunks).toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(gradleChecksum)) throw new Error('Invalid official Gradle checksum');
  const gradleZip = await artifact('gradle-8.10.2.zip', 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip', gradleChecksum);
  gradleHome = await packageRoot(await extract(gradleZip, 'gradle'), 'bin/gradle.bat');
}
const sdkRoot = path.join(cache, 'sdk');
let sdkReady = false;
const licenseAccepted = process.argv.includes('--sdk-license-accepted')
  || await readFile(path.join(cache, 'sdk-license-consent.txt')).catch(() => null);
if (licenseAccepted) {
  const platformZip = await artifact('platform-35.zip', 'https://dl.google.com/android/repository/platform-35_r02.zip', '0bb560a90a7a2cbd0dd8348224d518b638fe7949', 'sha1');
  const toolsZip = await artifact('build-tools-35.zip', 'https://dl.google.com/android/repository/build-tools_r35_windows.zip', 'af059bb67cf7786f45ee0db85e2d24985df1b4b6', 'sha1');
  const platform = await packageRoot(await extract(platformZip, 'platform'), 'android.jar');
  const tools = await packageRoot(await extract(toolsZip, 'build-tools'), 'source.properties');
  await mkdir(path.join(sdkRoot, 'platforms'), { recursive: true });
  await mkdir(path.join(sdkRoot, 'build-tools'), { recursive: true });
  await cp(platform, path.join(sdkRoot, 'platforms', 'android-35'), { recursive: true });
  await cp(tools, path.join(sdkRoot, 'build-tools', '35.0.0'), { recursive: true });
  // Consent is explicit; this marker is never created by the default setup.
  await writeFile(path.join(cache, 'sdk-license-consent.txt'), `Android SDK license accepted for this requested APK build: ${new Date().toISOString()}\n`);
  await writeFile(path.join(root, 'android', 'local.properties'), `sdk.dir=${sdkRoot.replaceAll('\\', '/')}\n`);
  const key = path.join(cache, 'debug.keystore');
  if (!await readFile(key).catch(() => null)) {
    const result = spawnSync(path.join(javaHome, 'bin', 'keytool.exe'), ['-genkeypair', '-keystore', key,
      '-alias', 'androiddebugkey', '-storepass', 'android', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '3650', '-dname', 'CN=HarborTube Development, O=Harbor Guard, C=BD'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Development signing key could not be generated');
  }
  sdkReady = true;
}
await writeFile(path.join(cache, 'toolchain.json'), JSON.stringify({ javaHome, gradleHome, sdkRoot, sdkReady }, null, 2));
console.log(sdkReady ? 'Project-local Android toolchain ready.' : 'Java and Gradle ready. SDK download/build awaits explicit SDK license acceptance.');
