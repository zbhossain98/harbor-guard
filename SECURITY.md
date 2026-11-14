# Security policy

Security fixes target the latest source on the default branch. Older builds do
not have a separate support commitment. Harbor Guard is experimental and has
not received an independent security audit.

## Report a vulnerability

If the GitHub repository's **Security → Advisories → Report a vulnerability**
option is available, use it to report privately. If it is unavailable, open an
issue requesting a private contact channel without including vulnerability
details, then wait for the maintainer to arrange one. Do not put exploit steps,
credentials, cookies or personal browsing data in a public issue.

In a private report, include the affected version, impact, a minimal reproduction
and any proposed fix. Remove personal data from logs and attachments. Response
times depend on maintainer availability.

## Relevant boundaries

The extension has broad website access for local filtering. Android uses
WebView, origin-scoped page messages and native download services. Reports about
page-to-native privilege escalation, cross-origin data exposure, unsafe download
redirects or unintended collection of browsing data are particularly useful.

An advertisement getting through is normally a filtering compatibility issue;
report it using the bug template unless it also crosses a security boundary.
