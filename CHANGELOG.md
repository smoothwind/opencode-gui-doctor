# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
