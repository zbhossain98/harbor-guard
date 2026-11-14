# HarborTube 0.2.2 playback changes

The persistent bottom bar is replaced with a floating Tools button and a compact
menu. The button fades during scrolling and disappears in fullscreen. Loading
indicators overlay the WebView, so showing them no longer changes the video's
viewport size.

Normal foreground playback no longer polls the mounted player's metadata every
two seconds or repeatedly rebuilds native icon backgrounds. Timeline messages
remain enabled for background audio and the open player controls. Download
catalogs are cached until their contents change, repeated media range requests
are deduplicated, and notification metadata updates only when the title or
duration changes.

Ad slots are hidden with CSS. A player-scoped observer and media events retain
the guarded skip behavior without rescanning the whole page after unrelated
recommendation updates.

## Validation

`scripts/android-playback-smoke.mjs` uses a fresh desktop Edge profile, locally
fulfilled page requests, a 24 fps canvas video, and changing recommendation DOM.
It compares the saved 0.2.1 assets with the new assets during about four seconds
of active playback:

| Observation | 0.2.1 | 0.2.2 |
| --- | ---: | ---: |
| Whole-document ad-slot scans | 34 | 0 |
| Mounted-player metadata reads | 4 | 1 |
| Native bridge messages | 8 | 3 |
| Presented video frames | 96 | 96 |

Both runs kept playing and hid newly inserted ad slots. These measurements show
reduced helper overhead in this controlled browser run. They do not establish
phone frame rates, network buffering behavior, or Android service performance.

The Android media/DOM tests also check that normal playback does not generate
repeating native progress messages, background/player controls still receive
timeline updates, and normal media events never seek or click skip controls.

## Phone playback check

Open a real video, then use **Tools → Settings → Playback check**. This reads
buffered seconds, decoded resolution, dropped frames and the installed WebView
version on demand. Refresh it to see whether dropped frames are increasing.
A depleted buffer suggests slow media delivery; rising dropped frames with a
healthy buffer suggests rendering or decoding load. Measurements stay on the
phone and are not uploaded.

Actual-phone validation is still required for playback smoothness, fullscreen,
background music and downloads. Performance depends on the phone, its WebView,
video codec/resolution and connection.
