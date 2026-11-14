import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.cache', 'android-toolchain');
const config = JSON.parse(await readFile(path.join(cache, 'toolchain.json'), 'utf8'));
const offline = process.argv.includes('--offline');
if (!config.sdkReady) throw new Error('SDK license acceptance and project-local toolchain setup are required before building.');
const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-android.mjs')], { stdio: 'inherit' });
if (prepared.status !== 0) process.exit(prepared.status || 1);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const env = { ...process.env, JAVA_HOME: config.javaHome, ANDROID_HOME: config.sdkRoot, ANDROID_SDK_ROOT: config.sdkRoot,
  GRADLE_USER_HOME: path.join(cache, 'gradle-user'), ANDROID_USER_HOME: path.join(cache, 'android-user'),
  JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, `-Duser.home="${path.join(cache, 'java-user')}"`].filter(Boolean).join(' ') };
const built = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  `& ${quote(path.join(config.gradleHome, 'bin/gradle.bat'))} ${offline ? '--offline ' : ''}--no-daemon --console=plain -p ${quote(path.join(root, 'android'))} testDebugUnitTest lintDebug assembleDebug`], { stdio: 'inherit', env });
if (built.status !== 0) process.exit(built.status || 1);
const apk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
const verifier = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  `& ${quote(path.join(config.sdkRoot, 'build-tools/35.0.0/apksigner.bat'))} verify --verbose ${quote(apk)}`], { stdio: 'inherit', env });
if (verifier.status !== 0) throw new Error('APK signature verification failed');
const badging = spawnSync(path.join(config.sdkRoot, 'build-tools/35.0.0/aapt.exe'), ['dump', 'badging', apk], { encoding: 'utf8', env });
if (badging.status !== 0 || !badging.stdout.includes("package: name='app.harborguard.youtube'")
  || !badging.stdout.includes("versionName='0.2.2'") || !badging.stdout.includes("sdkVersion:'26'")) {
  throw new Error('Unexpected APK identity or Android compatibility');
}
await mkdir(path.join(root, 'dist'), { recursive: true });
const output = path.join(root, 'dist/harbortube-0.2.2.apk');
await copyFile(apk, output);
await writeFile(`${output}.sha256`, `${createHash('sha256').update(await readFile(output)).digest('hex')}  ${path.basename(output)}\n`);
await writeFile(path.join(root, 'dist/harbortube-0.2.2-apk-info.txt'), badging.stdout);
console.log('Created dist/harbortube-0.2.2.apk — development signed, Android 8.0+');
