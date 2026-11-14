# Contributing

Bug reports, compatibility fixes, documentation and focused pull requests are
welcome. Please keep discussions respectful and explain reproducible behavior.

## Get started

Fork the repository, clone your fork and create a branch for your change.
Install Node.js 20 or newer. The extension and core tests have no npm dependencies,
so `npm install` is not required.

```sh
npm test
npm run check
node scripts/update-rules.mjs --check
npm run android:prepare
npm run package
npm run android:package
```

Load `extension/` as an unpacked extension in Chrome or Edge. Reload the extension
and affected tabs after edits. `npm run preview` serves a dashboard mockup at
`http://127.0.0.1:4173`; webpage controls cannot provide extension protection.

See [Android build instructions](android/README.md#build) for the Windows-based
toolchain setup, Java tests, lint and APK build. APK signing keys stay local.
Optional browser tests require Playwright and a compatible browser; see the
[README](README.md#develop-and-verify) for environment variables and commands.

## Making a change

- Keep pull requests focused and describe the user-visible effect.
- Add a regression test when changing filtering, playback, downloads or settings.
- Preserve ordinary playback and site exceptions. Avoid broad playback-domain blocks.
- Edit shared YouTube helpers in `extension/content/`, then run
  `npm run android:prepare` to update Android copies.
- Edit filter inputs or the converter, then run `node scripts/update-rules.mjs`.
  Include source metadata and required notices with changes to generated data.
- Run `--download` only for an intentional filter refresh; ordinary checks are offline.
- Never commit credentials, browser profiles, signing keys or generated build caches.

Before requesting review, run the checks above and describe any browser/device
checks performed. Automated fixtures do not prove live ad-blocking effectiveness.

## Reporting issues

Include the project version, browser or Android/WebView version, reproduction
steps, expected behavior and actual behavior. Remove cookies, signed media URLs,
account information and personal data from logs. Use [SECURITY.md](SECURITY.md)
for vulnerabilities rather than posting exploitation details publicly.

## Licensing contributions

By submitting a contribution, you agree to license original project code,
documentation and assets under MIT. Contributions to adapted filter data must
preserve the applicable CC BY-SA terms. Identify any third-party material and
include its license and attribution. See [third-party notices](THIRD_PARTY_NOTICES.md).
