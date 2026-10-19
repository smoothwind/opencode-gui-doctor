# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI test workflow (`test.yml`): typecheck + full suite on ubuntu and windows.
- `gui_cdp_inspect` output lists the failed requests it observed.

### Fixed

- The storage preset's `sessionStorage` tree was redacted wholesale (the key
  name matches the `session` pattern); composite values under sensitive keys
  are now recursed into — inner secrets stay masked, the rest stays readable.
- CDP probes accept `preset` readers: the tool schema allowed them but the CDP
  harness ignored the field and failed with an opaque eval error.
- A harness process killed hard (abort / OOM) now leaves an explicit
  `ok:false, incomplete:true` result file instead of a half-written success.
- An unhandled rejection now closes the launched browsers before exiting, so
  they no longer survive as orphans.
- Steps' `testId` (camelCase, as exposed by the tool schema) is now honoured by
  the runtime — previously only lowercase `testid` matched, so `testId`-only
  steps failed with "requires selector".
- `expectText` waits for the element to attach and polls until the step timeout
  instead of failing on the first read when the element is missing.
- A harness timeout force-closes the launched browsers instead of orphaning
  them; aborting a run kills the whole harness process tree (Windows included).
- Forks whose `patchAfterLoad` fails to apply are marked failed instead of
  silently producing a misleading diff.
- Navigation URLs written to `audit.log` are redacted, so tokens in query
  strings never land there in clear text.
- `gui_cdp_inspect` now asks for the `gui.navigate` permission for
  out-of-allowlist `goto` targets instead of failing the run.
- CDP failed requests report their URL (mapped from `requestWillBeSent`).
- Plugin's node resolution no longer trips over `.cmd`/`.bat` shims on Windows.

### Changed

- The CDP perf trace starts before navigation, so first load is captured.
- CDP console / page-error / failed-request buckets are capped (2000 entries)
  so long observation windows stay bounded.
- `audit.log` halving resumes at a line boundary so JSON entries are never
  split mid-record.
- Response body capture skips non-textual and oversized payloads instead of
  decoding binary bodies into mojibake.
- Fork diffs report `consoleChanged` (content-level) alongside `consoleDelta`.
- Job scanning (JS features / nav URLs) lives in `runtime/lib/jobscan.mjs`,
  shared by the plugin gate, the CLI and the harness-side assert.
- Tool argument schemas moved to `plugin/schema.ts`.
- Tests pick the browser channel via `detectBrowserChannel` (no hard-coded
  msedge) and skip cleanly when playwright is not installed.

## [0.1.5] - 2026-10-16

### Added

- Initial public release.
- opencode plugin plus the `gui-diagnostics` skill, exposing six tools:
  `gui_doctor_env`, `gui_trace_record`, `gui_trace_analyze`, `gui_probe_fork`,
  `gui_cdp_inspect`, `gui_bisect`.
- Playwright trace recording with console / page-error / network capture, a
  structured digest, flake detection (`runs: N`), and failure evidence
  (`screenshotOnFailure`, `video`, response `body` capture).
- Forked replay probes: replay to a `forkAt` step across isolated variants
  (init scripts, route mocks, patches) with baseline diffing, plus a visual and
  accessibility-tree diff.
- Step-by-step `bisect` to localize the first failing step or a custom `until`
  predicate.
- Live Chrome DevTools (CDP) inspection with DevTools perf traces, CDP
  breakpoint probes, and optional `closeOnExit` ownership.
- Deterministic replay: `network.har` record/replay, `seed` for `Math.random`,
  and `clockTime` to freeze the page clock.
- Visible labelled container (iframe wrapper for web, banner for cdp/electron)
  so the window under test is obvious.
- Default-safe security policy: JavaScript-injection gate (`allowJsProbes`),
  origin allowlist, filesystem sandbox, secret redaction, and an audit log.
- `gui-doctor` CLI (`env`, `record`, `fork`, `bisect`, `cdp`, `analyze`, `run`).
- Static documentation site published to GitHub Pages.
- MIT license.

[Unreleased]: https://github.com/smoothwind/opencode-gui-doctor/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/smoothwind/opencode-gui-doctor/releases/tag/v0.1.5
