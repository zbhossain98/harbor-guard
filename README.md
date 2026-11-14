# Harbor Guard

Open-source ad and tracker filtering for Chrome, Edge and Android.

[Download source](https://github.com/zbhossain98/harbor-guard/archive/refs/heads/main.zip) ·
[Report a bug](https://github.com/zbhossain98/harbor-guard/issues) ·
[Changelog](CHANGELOG.md)

| Project | Version | Get started |
| --- | --- | --- |
| Harbor Guard browser extension | 0.3.3 | [Install](#install) |
| HarborTube Android app | 0.2.2 | [Android guide](android/README.md) |
| Optional Windows Defender helpers | — | [Windows guide](windows/README.md) |

Original code, documentation and icons use the [MIT License](LICENSE).
Bundled EasyList/EasyPrivacy data remains **CC BY-SA 3.0**; Android dependencies
retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).

Contributions are welcome: [contributor guide](CONTRIBUTING.md) ·
[security policy](SECURITY.md).

These are experimental development builds. Live ad delivery changes, and
automated fixtures do not guarantee ad-free playback or Android device behavior.

A Chrome and Microsoft Edge extension with local ad/tracker filtering, site
exceptions, cosmetic cleanup and a YouTube player helper. Optional Windows
scripts use Microsoft Defender. The extension does not scan files or replace
antivirus; keep Windows Security and browser phishing protection enabled.

## Update to 0.3.3

1. If you loaded this project's `extension` folder, its files are already updated.
   If you loaded an extracted ZIP, replace that folder's files with the contents
   of `dist/harbor-guard-0.3.3.zip`.
2. Open `chrome://extensions` or `edge://extensions`, find **Harbor Guard**,
   click **Reload**, and verify version **0.3.3**.
3. Turn on the master switch and **YouTube helper**, and remove any YouTube site
   exception. Reload every open YouTube tab with **Ctrl+Shift+R**.
4. Open Harbor Guard's popup on YouTube. It should say **YouTube helper 0.3.3 is
   active on this tab**. If it asks to reload the tab, open YouTube in a new tab.

Reloading matters: the new helper must run before YouTube's first page script.
Pausing cannot restore player metadata already removed. Reload after changing
the helper switch or a site exception.

## What changed

Version 0.3.3 adds bounded playback recovery for the specific `UNPLAYABLE`
ad-block error that links to YouTube's ad-block help page. The earlier Promise
guard cannot recover a playback response that already contains that error.

- Watches the native player and delayed error renderers, then tries the WEB
  `CHANNEL` and inline playback contexts on this video's `/youtubei/v1/player`
  POST requests. It makes at most two native reload attempts, four seconds
  apart, and preserves the playback position and paused playback intent.
- Keeps the original account/client identity, user agent, attestation, headers,
  request signals and playlist parameters. Normal requests are unchanged until
  that specific error is observed. Fetch string/Request bodies and XHR are covered.
- Honors master pause, the YouTube switch and site exceptions, including queued
  retries and pending request-body reads. A different video resets recovery;
  same-video page updates and toggle cycles cannot create an endless retry loop.
- Cleans player data prefetched by `/youtubei/v1/navigation/resolve_url`, keeping
  navigation and unrelated response data. Stops hiding the generic `#player-ads`
  container, which the maintained compatibility filters now exempt.
- Reports recovery readiness and retry/exhausted status in the popup. It leaves
  real error screens visible if recovery fails; captcha, sign-in, regional and
  unrelated playback errors are not retried.

This update passed 143 automated tests and an isolated Edge browser check
using controlled YouTube-shaped responses, including a warning appearing after
page load. A manual Chrome retest was reported working on 14 November 2026.
That is a limited compatibility check; live YouTube delivery can still vary.
Reload both the extension and YouTube to apply the update.

Version 0.3.2 adds an early guard for YouTube's known `onAbnormalityDetected`
Promise callback, informed by the maintained
[uAssets Quick fixes pattern](https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt).
Removing ad metadata alone did not handle that warning path. The guard follows
the YouTube helper switch, master pause and site exceptions, including callbacks
that are already queued when settings change. Other Promise callbacks, rejection
handlers, player responses and account data retain their existing behavior.
The popup now verifies that this compatibility guard has loaded before reporting
that the updated helper is active. It adds no new permissions or network access.

Reload both the extension and YouTube to apply it: an already-displayed warning
cannot be undone by injecting a guard after the detector has run. This patch
does not clear a server-side/account restriction or conceal a playback error.
If the warning persists, **Pause on this site** and reload for normal playback
with ads while checking whether another blocker is also active.

Version 0.3.1 follows the maintained-filter and early page-script approach used
by Brave. Its independently implemented YouTube helper:

- Uses persisted, settings-controlled MAIN-world registration at `document_start`,
  avoiding an asynchronous preferences read before it can protect initial data.
- Cleans `ytInitialPlayerResponse` and `playerResponse` assignments before inline
  player code consumes them, prevents later ad-field reinsertion, and handles
  recognizable serialized player JSON and array envelopes.
- Removes `adPlacements`, `playerAds` and `adSlots` from supported JSON fetch and
  XMLHttpRequest responses, including nested and array player envelopes on
  `/youtubei/v1/player`, `/youtubei/v1/playlist` and `/youtubei/v1/get_watch`.
- Covers legacy JSON `/watch` and `/playlist` responses, preserving anti-XSSI
  guards. Scoped Response prototype hooks cover borrowed methods and byte/Blob
  reads that bypassed instance methods in 0.3.0.
- Handles classless SSAP ad segments using the player's explicit `SSAP, AD`
  marker and native segment progress. Media events trigger bounded seeks only
  for marked, short, playing ad segments. Normal, paused, live, buffering and
  unchanged main-video timelines are left alone. This does not rewrite server
  contracts or modify account/client identifiers.
- Retains the guarded native skip/dismiss fallback for visible player ads.

The bundled network data now includes **51,948 ad domains** and **46,719 tracker
domains** from EasyList/EasyPrivacy snapshots dated 24 October 2026 plus local
entries. It compiles to 1,700 browser rules, including compatibility exceptions.
This is a hostname subset, not the full EasyList or Brave engine. There are no
blanket blocks on YouTube's normal playback domains.

Chrome/Edge extensions cannot reproduce Brave's native response-filtering
engine. This helper does not implement every YouTube transport or server-side
ad mechanism; live delivery can change. No universal ad-free guarantee or new
Turtlecute score is claimed.

## Install

Download the [source ZIP](https://github.com/zbhossain98/harbor-guard/archive/refs/heads/main.zip)
and extract it, or clone this repository. The browser extension is in `extension/`.

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode** and select **Load unpacked**.
3. Select this project's `extension` folder, or an extracted extension ZIP.
4. Pin Harbor Guard and reload sites that were already open.

Open the toolbar popup for site controls or **Open dashboard** for all settings.
The extension needs no build, account or npm dependencies to run. It is an
unpacked development build, not a Chrome Web Store release or independently audited product.

## Controls and privacy

Ad filtering, tracker filtering, cosmetics and the YouTube helper have separate
switches. The master switch pauses all layers while retaining their preferences.
Site exceptions apply to a domain and its subdomains. Reload affected sites
after changing network rules or exceptions.

`declarativeNetRequest` applies browser rules; `scripting` registers the early
YouTube helper; `storage` keeps settings and aggregate activity locally;
`activeTab` supplies the popup's current hostname. Website access lets the
isolated content script clean ad slots. Browser-internal and protected pages
cannot be modified.

There are no remote scripts, telemetry, accounts, browsing-history logs or page
content uploads. Filter refreshes are manual developer actions. Activity stores
aggregate cosmetic hides and observed YouTube actions, not network URLs or a
count of blocked network requests. Removed player metadata is not counted as
a confirmed blocked ad. The MAIN-world public event controls only its local
helper and cannot change saved extension settings or access storage.

For PC protection, open **Windows Security → Virus & threat protection → Quick
scan**. Optional status/scan helpers are documented in `windows/README.md`.

## Develop and verify

Use Node.js 20 or newer:

```powershell
npm test
npm run check
node scripts/update-rules.mjs --check
npm run preview
npm run package
npm run android:prepare
npm run android:package
```

The preview at `http://127.0.0.1:4173` shows the dashboard design; its controls
are disabled because a normal webpage cannot provide extension protection.

Earlier version 0.3.2 validation included **129 automated tests** plus an Edge smoke test using a
fresh profile and controlled YouTube-shaped responses. That test covers early
browser rule-engine matches, inline assignment, serialized JSON, fetch/clone/text, XHR JSON/text, native XHR
errors, borrowed Response methods, byte/Blob reads, anti-XSSI, ad reinsertion,
SSAP fallback, the known warning callback, both helper readiness signals, preserved playback data, pauses, site exceptions
and browser restart.
Controlled fixtures do not prove effectiveness against live YouTube ads.

In an earlier 0.3.1 signed-out Edge check, public video `0e3GPea1Tyg` played normally for about
16 seconds with the new response/runtime helpers and no observed ad state.
That observation does not establish blocking for your account, region or longer
playback. A controlled SSAP fixture verifies the new fallback and its guards;
the live check did not reproduce an SSAP ad. The 0.3.2 live check was blocked by
the test environment's network restriction; its warning fix still needs a live
retest in the affected browser/account.

The optional browser scripts require Playwright and an installed Chromium
browser. `HARBOR_PLAYWRIGHT_PATH` can point to the Playwright package and
`HARBOR_BROWSER_PATH` to a compatible browser executable:

```powershell
npm run test:browser
node scripts/youtube-live-check.mjs
```

Both scripts use separate profiles inside `.cache/`, never personal browser
profiles. The smoke test fulfills requests with fixtures. The live diagnostic
loads two public videos signed out and reports playback/ad observations, which
can vary by region and YouTube rollout. Also retest with your own signed-in
session after reloading the extension. Check normal videos, consecutive ads,
mid-rolls, live streams and paused protection in both Chrome and Edge.

## Filter sources and packaging

Read [filter documentation](extension/rules/README.md),
[filter attribution](extension/rules/ATTRIBUTION.md) and
[filter license](extension/rules/LICENSE) for coverage,
EasyList authors' attribution, conversion limitations and CC BY-SA 3.0 terms.
Exact source hashes and versions are recorded in
[`extension/rules/source-manifest.json`](extension/rules/source-manifest.json).

```powershell
node scripts/update-rules.mjs --download
```

This downloads public filter sources and license text; ordinary rebuilds and
checks stay offline. Sources live in `data/filter-sources/` and are included
in `dist/harbor-guard-0.3.3-source.zip`. The installable folder's archive is
`dist/harbor-guard-0.3.3.zip`. Keep both archives together when distributing
the build. Research caches, test browser profiles and Git files are excluded.

The Turtlecute test treats request failures as blocking, so unrelated DNS or
network failures can affect its score. Retest after updating; neither configured
domain counts nor the previous 33/132 result establishes current live coverage.
