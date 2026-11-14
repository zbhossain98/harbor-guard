# HarborTube Android

An independent YouTube-only app using Android System WebView. Version **0.2.2**
uses YouTube's own logo, search, navigation and video controls with one floating
**Tools** button opening **Download · Listen · Saved · Settings**. The four-button
bottom bar is removed; the WebView keeps its full height while loading and opening controls. Local MP4/M4A/WebM downloads and
opt-in background audio with notification and lock-screen controls are included.
Home, Shorts, fullscreen, local ad/tracker filtering
and the Harbor Guard YouTube helper remain included. This does not modify the
Google YouTube APK and uses no HarborTube server, telemetry or account import.

The player helper source remains **0.3.1**.
Playback overhead changes and controlled measurements are documented in
`PERFORMANCE.md`. These checks do not establish actual phone frame rates.
The app requires Android 8.0 or newer. Update Android System WebView for early
player filtering. On older providers, only the guarded DOM fallback is used;
the app's About screen reports that limitation.

## Install

After a successful build, copy `dist/harbortube-0.2.2.apk` to your Android phone, open it and choose
Install. Android may ask you to permit APK installation from the app you used
to open the file. Then launch HarborTube and use its Home, Shorts or Search
controls. Protection is enabled by default; **Tools → Settings** opens protection settings, reload and an on-demand playback check.
Install over 0.1.0 or 0.2.0 using the same signing key to keep protection settings.

## Background music

Play a video, then tap **Tools → Listen** and choose **Listen in background**.
Playback uses the same WebView
in a foreground media service; switching apps and screen-off do not deliberately
pause it. A media notification/MediaSession exposes play, pause, stop and seek.
Headphone disconnection pauses playback. Chromium manages the player's audio
focus; the native service does not make a competing request that pauses it.
Background audio is session-based and stops when the app is removed from Recents;
it does not restart automatically after process death. Modern Android System
WebView with document-start injection and WebMessage support is required.

## Downloads

Play the desired video, then tap **Tools → Download** and select an available MP4/WebM
quality or an audio-only option. The sheet refreshes as streams are identified;
it also reads metadata from the mounted player when initial globals are absent.
Android 10+ saves into
`Download/HarborTube`; Android 8–9 asks for a location with the system file picker.
Use **Tools → Saved** for progress, cancel and opening saved files offline.
Only one job runs at a time, with a 2 GB / 30 minute limit. Temporary media stays
in app cache and is removed on completion, cancellation or handled failure.

The app observes the current player's media metadata and public HTTPS
`*.googlevideo.com/videoplayback` requests. Ciphered/throttled URLs become usable
only when matched to a URL the current player actually requests, by media ID
and format ID; no signature/DRM bypass, extractor server or alternate account
client is used. More qualities may appear after playing them. Signed URLs can
expire or be refused, and live, protected and some ordinary videos will not
offer downloadable formats. H.264 MP4, AAC M4A and VP9/Opus/Vorbis WebM are
supported. Opus video/audio muxing requires Android 10+, while audio-only WebM
can be saved without muxing on Android 8–9. Partial CDN responses are assembled
with contiguous ranges instead of being rejected as incomplete files. Separate video
and audio tracks are combined locally with Android MediaMuxer, without encoding.
Downloaded files and a local library of their titles, dates and content URIs
remain on the phone; no streaming URLs or cookies are persisted in that library.

## Build

The bundled setup and build scripts currently require **Windows and PowerShell**.
Core JavaScript tests and source packaging also run on Linux and macOS.

Java, Gradle and SDK components stay in `.cache/android-toolchain/`; no machine
installation or administrator changes are needed. Read Google's Android SDK
license before accepting it. The setup flag explicitly records acceptance for
this requested build. Download metadata/license are available from:

- https://dl.google.com/android/repository/repository2-1.xml
- https://developer.android.com/studio/terms

```powershell
node scripts/setup-android.mjs --sdk-license-accepted
npm run android:build
```

This downloads checksum-verified JDK 17, Gradle 8.10.2, Android platform 35 and
build tools 35.0.0. Gradle resolves AGP 8.8.2 and AndroidX WebKit 1.12.1 from
their public repositories. It runs native filtering tests and Android lint, compiles the app,
checks the APK signature and writes `dist/harbortube-0.2.2.apk`.
After dependencies are cached, `node scripts/build-android.mjs --offline`
builds without repository access. JVM homes and build caches stay in the project.

Run `npm run android:package` to create `dist/harbortube-0.2.2-source.zip` with
the source, helper tests, original filter snapshots and licenses. Build caches,
signing keys and machine-specific `local.properties` are excluded.

The APK uses a local development signing key, stored only in the ignored build
cache. It is not a Play Store release. Keep that key to sign compatible future
updates; the source archive does not include it, tool downloads or local paths.

## Protection and privacy

The early script uses AndroidX document-start injection and no Java object
bridge. An origin-scoped AndroidX WebMessage listener accepts main-frame YouTube
playback state and format metadata with bounded message sizes. Page messages
cannot start downloads, change native settings or invoke file/Android APIs.
Downloads require a native user action and validate URLs again on every redirect.
Network blocking uses a third-party host subset of the bundled EasyList and
EasyPrivacy snapshots. WebView does not expose reliable resource types, so
upstream exceptions are broadened conservatively instead of dropped. Native
request counters show blocked requests, not confirmed skipped video ads.

YouTube can change ad delivery and enforce player contracts; ad-free playback
is not guaranteed. Ads in the original YouTube app are outside this client's
scope. Google's sign-in availability depends on its WebView policies. This is
not an implementation of Premium account services.

WebView stores cookies/cache locally; the app does not upload them or maintain
a separate visited-URL log. Native HTTP downloads use the current WebView user
agent and host-scoped cookies; neither is sent to a third-party extractor.
Third-party cookies, file/content access, mixed HTTP
content, automatic popups and page-requested camera/microphone access are off.
Browser Safe Browsing remains enabled. Internet, foreground media/data-sync
services, bounded wake locks and notifications are requested for playback and
downloads. No broad storage, camera, microphone or contacts permission is used.
Settings changes reload the page; pausing does not restore already removed
metadata until reload.

## Source notices and device checks

Original HarborTube code uses the [MIT License](../LICENSE), copied into built
app assets as `SOURCE-LICENSE.txt`. See [third-party notices](../THIRD_PARTY_NOTICES.md)
and the [contributor guide](../CONTRIBUTING.md) before redistributing changes.

The EasyList authors (https://easylist.to/) supply the source filters, adapted
under CC BY-SA 3.0. Source hashes and full notices are included in app assets and
the source archive. AndroidX and its Apache-licensed dependencies are covered
by `ANDROIDX-LICENSE.txt` and `THIRD-PARTY.md` in app assets.

Before wider distribution, install on actual Android devices and check startup,
early helper support, normal videos, ads, mid-rolls, live streams, fullscreen,
rotation, navigation, pause/resume and settings persistence. Also verify audio
focus, screen-off playback, notification controls, headset unplug, download
quality selection, local muxing, cancellation, storage failure, expired URLs and
Android 8–9 file-picker persistence. JVM/desktop browser
tests do not establish actual phone playback or every YouTube rollout.
