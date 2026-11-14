# Third-party notices

Harbor Guard's original code, documentation and original icons are licensed
under the MIT License in the root `LICENSE`. Third-party material keeps its
own license; the MIT License does not replace the licenses below.

## EasyList and EasyPrivacy — CC BY-SA 3.0

The EasyList authors maintain [EasyList and EasyPrivacy](https://easylist.to/).
This project selects Creative Commons Attribution-ShareAlike 3.0 Unported
under their [upstream licensing terms](https://easylist.to/pages/licence.html).

This applies to the original snapshots in `data/filter-sources/`, the adapted
network data in `extension/rules/ads.json` and `extension/rules/trackers.json`,
their generated catalog and source metadata, and Android's derived
`android/app/src/main/assets/filters.json` and filter metadata.

The conversion extracts hostname rules, preserves conservative exceptions,
deduplicates data and combines it with local entries. It provides a subset of
the original lists. Redistribution of that adapted data must retain attribution,
identify changes and use CC BY-SA 3.0 or a license permitted by its terms.

Detailed attribution and source links are in `extension/rules/ATTRIBUTION.md`;
the full license is in `extension/rules/LICENSE` and `data/filter-sources/LICENSE`.
Android copies are `FILTERS-ATTRIBUTION.md` and `FILTERS-LICENSE.txt` in app assets.
Exact source versions and hashes are in `extension/rules/source-manifest.json`.

## Android dependencies — Apache 2.0

AndroidX WebKit and its AndroidX dependencies are from the Android Open Source
Project and use the Apache License 2.0. Kotlin standard-library dependencies,
when resolved, are copyright JetBrains s.r.o. and Kotlin contributors under
Apache 2.0. Android build assets retain `THIRD-PARTY.md` and the full
`ANDROIDX-LICENSE.txt`. Gradle resolves these dependencies during the build.

- [AndroidX source](https://android.googlesource.com/platform/frameworks/support/)
- [Kotlin source](https://github.com/JetBrains/kotlin)

Build tools and test dependencies retain their own licenses. Downloaded JDKs,
SDKs, Gradle distributions and browser runtimes are not included in source ZIPs.

## Independent implementation and external services

The YouTube helpers are implemented in this project. Research references to
Brave and uBlock Origin are listed in `extension/rules/ATTRIBUTION.md`; their
runtime implementations are not bundled.

Android System WebView is installed separately. YouTube pages and branding
displayed by the website belong to their respective owners. This project is
independent and is not affiliated with Google, YouTube, Microsoft or Brave.
