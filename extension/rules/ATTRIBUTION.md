# Filter attribution

The bundled advertising and tracking rule data is adapted from EasyList and
EasyPrivacy by **The EasyList authors (https://easylist.to/)**, combined with
Harbor Guard's local host entries. Those adapted filter files are distributed
under **Creative Commons Attribution-ShareAlike 3.0 Unported**. The full terms
are in `LICENSE` alongside this notice.

- Original EasyList: https://easylist.to/easylist/easylist.txt
- Original EasyPrivacy: https://easylist.to/easylist/easyprivacy.txt
- Upstream licensing: https://easylist.to/pages/licence.html
- Selected license: https://creativecommons.org/licenses/by-sa/3.0/

Harbor Guard's conversion selects hostname rules, preserves conservative
network exceptions, deduplicates entries, and converts them to Manifest V3
browser rules. This changes coverage from the original lists. Exact source
versions, hashes, conversion counts and license hash are in
`source-manifest.json`. Original snapshots and the converter are included in
the accompanying Harbor Guard source archive.

The YouTube scripts are independently implemented in this project. Their
approach was informed by Brave's documented blocker and public uBlock Origin
YouTube filter patterns; no Brave/uBlock runtime or filter script is bundled:

- https://github.com/brave/adblock-rust
- https://github.com/brave/adblock-resources
- https://github.com/brave/adblock-lists/blob/master/brave-lists/brave-specific.txt
- https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters.txt
- https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt

Reference patterns inspected on 24 October 2026: prune `adPlacements`,
`playerAds`, and `adSlots` from initial player objects and player API envelopes;
handle fetch, XMLHttpRequest and serialized player JSON before consumption.
Version 0.3.1 also uses the explicit `SSAP, AD` player stats marker and native
segment progress for a bounded ad-only seek fallback. Initial ad fields are
kept undefined against later assignment, following the constant-field pattern.
Harbor Guard implements a narrower subset and does not include Brave's native
network engine, HTML response filtering or SABR server-contract recovery.

Version 0.3.2's reference check on 5 November 2026 identified the Quick fixes
pattern for Promise fulfillment callbacks containing `onAbnormalityDetected`.
The extension implements its own early, settings-controlled guard for that
specific callback, preserving ordinary callbacks and rejection behavior. It
does not copy the upstream script or its broader server-contract/request edits.

Version 0.3.3's reference check on 14 November 2026 identified the current
Quick fixes patterns for the `UNPLAYABLE` error linking to YouTube help article
3037019, WEB `clientScreen: CHANNEL` and `isInlinePlaybackNoAd` contexts, the
`navigation/resolve_url` prefetched player envelope, and the `#player-ads`
cosmetic exception. The extension independently implements two bounded native
player retries and scoped request-body edits, with pause/position handling and
native error propagation. It does not copy the upstream script, rotate user
agents, remove error screens, or ship a remote filter/script execution engine.
