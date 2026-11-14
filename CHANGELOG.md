# Changelog

## 0.3.3 — 2026-11-14

First public source release of Harbor Guard, including the browser extension,
HarborTube Android sources, optional Windows helpers, tests and build scripts.
Original code uses MIT; bundled filter data retains CC BY-SA 3.0 and attribution.

- Recover the specific YouTube ad-block playback error with at most two native
  player retries, preserving playback position, pause intent and playlists.
- Cover player data prefetched by YouTube's navigation endpoint.
- Keep the generic YouTube player-ad container available for compatibility.
- Show helper readiness and recovery state in the extension popup.
- Preserve site exceptions, settings, account identity and ordinary errors.

Validation: 143 automated tests, controlled Chromium browser checks including
restart and pause/exception behavior, packaging and filter-integrity checks.
A manual Chrome retest was reported working. Live ad delivery can change.

## 0.3.2

- Add an early guard for YouTube's known ad-block warning Promise callback.
- Verify the warning guard is loaded before reporting the helper as active.

## 0.3.1

- Register the YouTube helper before page scripts run.
- Cover initial, serialized, fetch and XHR player responses.
- Add a bounded fallback for explicitly marked SSAP ad segments.
- Expand bundled hostname filtering from EasyList and EasyPrivacy snapshots.
