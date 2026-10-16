# opencode-gui-doctor

[![npm](https://img.shields.io/npm/v/opencode-gui-doctor.svg)](https://www.npmjs.com/package/opencode-gui-doctor)
[![license](https://img.shields.io/npm/l/opencode-gui-doctor.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-github%20pages-blue)](https://smoothwind.github.io/opencode-gui-doctor/)
[![node](https://img.shields.io/node/v/opencode-gui-doctor.svg)](https://nodejs.org)

GUI error diagnosis for coding agents — Playwright trace recording, trace analysis,
forked replay probes, and Chrome DevTools (CDP) inspection. **Default-safe**
(allowlists, sandbox, redaction).

Turn a reproducible GUI failure into a recorded Playwright trace, a structured
digest, and **forked replay probes** that test hypotheses in isolation — instead
of guessing from source alone.

📖 **Documentation: <https://smoothwind.github.io/opencode-gui-doctor/>**

## Why

When a UI action errors, renders wrong, or silently fails, the stack trace alone
is often not enough. You need to know what the console said, which network calls
failed, and what the app state looked like *around* that specific click. This
plugin gives an agent a repeatable way to reproduce and interrogate GUI bugs:

- **Record** a scripted scenario with Playwright tracing → console / network /
  error capture plus a human-readable digest.
- **Fork** the replay at any step across isolated variants (init scripts, route
  mocks, source patches) and diff the results against a baseline.
- **Bisect** the steps to find the first action that triggers the failure.
- **Attach** live to an already-running Chrome/Chromium/Electron over CDP for
  perf traces and real-state probing.

## Install

### As an opencode plugin

```json
{ "plugin": ["opencode-gui-doctor"] }
```

Add it to `opencode.json` and restart opencode. The plugin registers the
`gui-diagnostics` skill, so the agent knows when and how to reach for the tools.

Local checkout instead of npm:

```json
{ "plugin": ["./packages/opencode-gui-doctor/plugin/index.ts"] }
```

The plugin resolves its runtime relative to itself, so it works from any project.
`playwright` is an **optional peer dependency** — install it in the project you
are diagnosing:

```bash
npm i -D playwright
# or use a system browser to avoid downloads:
#   pass browser.channel: "msedge" | "chrome"
```

### CLI

```bash
npm i -g opencode-gui-doctor
gui-doctor env
gui-doctor record --url http://localhost:1420 --channel msedge --steps steps.json
```

## Tools

| Tool | Purpose |
| --- | --- |
| `gui_doctor_env` | Check Node, Playwright resolution, and available Chrome/Edge. Run **first**. |
| `gui_trace_record` | Run a scripted UI scenario with Playwright tracing; capture console/network/errors + a digest. Writes `trace.zip` (open with `npx playwright show-trace`). |
| `gui_trace_analyze` | Parse a `trace.zip` or run dir into failed actions, page errors, console errors, failed requests, slowest actions. |
| `gui_probe_fork` | **Forked replay probe**: replay a scenario to a `forkAt` step across isolated variants (init scripts, route mocks, patches) and read probes; diffs against the `baseline` fork. |
| `gui_cdp_inspect` | Attach to a running Chrome/Chromium/Electron over CDP, collect console/exceptions/failed requests, run probes, record a DevTools perf trace. |
| `gui_bisect` | Replay steps one-by-one, probe after each, and report the **first step** that triggers a failure (or a custom `until` predicate). |

Browser selection: if the project has no bundled Chromium, pass
`browser.channel: "msedge"` or `"chrome"` (system browsers avoid downloads).

Iframes: add `frame: ["#my-iframe", ".inner"]` to any step to scope it into an
iframe chain. Probes can read across same-origin frames in `expression`.

## Workflow

1. `gui_doctor_env` — confirm Playwright + a browser channel.
2. `gui_trace_record` — reproduce the bug with `steps` (e.g. `goto`, `click`,
   `fill`, `expectText`) and read the digest. `expect*` assertions auto-wait within
   the step timeout, and each step result lists the page errors / console errors /
   failed requests observed during that step, so failures point straight at the
   offending interaction.
3. `gui_trace_analyze` — drill into the produced `trace.zip` when you need the
   full error/console/network lists.
4. `gui_probe_fork` — form 2+ hypotheses as forks that share a replay prefix.
   Compare `changedProbes` and `failedStepDelta` against `baseline`.
5. `gui_cdp_inspect` — when the app is already running (dev server + browser with
   `--remote-debugging-port`, or Electron), attach live for perf traces and to
   probe real state.

## Forked replay example

```json
{
  "url": "http://127.0.0.1:5173",
  "target": "web",
  "steps": [
    { "action": "click", "selector": "#open-modal" },
    { "action": "click", "selector": "#submit" }
  ],
  "forks": [
    { "id": "baseline", "forkAt": 1, "probes": [{ "name": "state", "expression": "() => window.__STATE__" }] },
    { "id": "api-500", "forkAt": 1, "routeMocks": [{ "url": "**/api/submit", "status": 500, "body": {} }],
      "probes": [{ "name": "state", "expression": "() => window.__STATE__" }] },
    { "id": "disable-cache", "forkAt": 1, "initScripts": ["sessionStorage.clear = () => {}"],
      "probes": [{ "name": "state", "expression": "() => window.__STATE__" }] }
  ]
}
```

If only `api-500` reproduces the failure, the root cause is the error path around
the API. If `disable-cache` changes behavior, investigate caching.
`diff.diffs[].changedProbes` lists exactly what diverged.

## Advanced diagnosis

- **Flake detection** (`runs: N`): replays the scenario N times, each with a fresh
  browser, and reports a per-step pass/fail matrix plus the flaky steps.
- **Failure evidence** (`capture`): `screenshotOnFailure`, `video`, failed
  request/response `body` capture (bounded, key-aware redaction applies).
- **Parallel forks** (`forkConcurrency`): run up to N fork variants concurrently,
  each with its own isolated browser and a fork-suffixed container label.
- **CDP ownership** (`closeOnExit`): leave the attached browser running (default)
  or kill it via raw CDP on exit.
- **Artifact retention** (`.gui-doctor.json` → `retention`): prunes old `runs/`
  directories and halves `audit.log` past a size cap.
- **Deterministic forks** (`determinism`): record `network.har` once, replay it so
  forks see identical upstream responses; `seed` fixes `Math.random`, `clockTime`
  freezes the page clock.
- **CDP breakpoint probes** (`breakpointProbes`): pause at a script `url`/`line`
  and read locals via `evaluateOnCallFrame` (Chromium only, auto-resumes).
- **Source maps**: stacks are best-effort mapped back to `.ts`/`.vue`.
- **Visual + a11y diff**: changed-pixel ratio and an accessibility-tree line diff
  versus the `baseline` fork.

## Security policy (default-safe)

The plugin is **default-deny** and enforced by both the plugin (permission gating)
and the harness (runtime enforcement):

- **No JavaScript injection by default.** `probes`, `initScripts`, `routeMocks`,
  `patchAfterLoad`, and `evaluate` steps are refused unless `allowJsProbes` is
  enabled. On demand the plugin asks for permission (`gui.evaluate`) and grants it
  for that run only.
- **Outbound allowlist.** Navigation is limited to `localhost / 127.0.0.1 / [::1]`
  by default; anything else asks for `gui.navigate`. Same for CDP endpoints
  (`gui.cdp`).
- **Filesystem sandbox.** `initScripts` paths, `storageState`, `outputDir` and
  Electron executables must live inside the project root (or `allowedPaths`).
- **Redaction.** Console text, page errors, probe results and network URLs are
  scrubbed of secrets (Authorization/Cookie/JWT/Bearer/AWS/GitHub tokens + sensitive
  key names) before anything is returned to the model.
- **Raw traces are not attached by default.** The redacted `diagnostics.json` is
  attached instead; `trace.zip` is still written and its path printed.
- **Audit log.** Every run, navigation and JS grant is appended to
  `.gui-doctor/audit.log`.

Configure via `.gui-doctor.json`, plugin options, or env vars:

```json
{
  "allowedOrigins": ["http://localhost:*", "https://staging.myapp.com"],
  "cdpAllowedEndpoints": ["http://127.0.0.1:*"],
  "allowJsProbes": false,
  "allowedPaths": ["../shared-fixtures"],
  "redaction": { "allowAttachRawTrace": false, "entropyHeuristic": false },
  "timeouts": { "step": 15000, "harness": 240000 }
}
```

Env overrides: `GUI_DOCTOR_ALLOW_JS=1`, `GUI_DOCTOR_ALLOWED_ORIGINS=...`,
`GUI_DOCTOR_ALLOW_RAW_TRACE=1`, `GUI_DOCTOR_NODE=/path/to/node`.

## CLI reference

```text
gui-doctor env     [--project <dir>] [--json]
gui-doctor analyze <trace.zip|run-dir> [--project <dir>]
gui-doctor record  --url <url> [options]
gui-doctor fork    --url <url> --forks <file|json> [options]
gui-doctor bisect  --url <url> --steps <file|json> [options]
gui-doctor cdp     [--endpoint http://127.0.0.1:9222] [options]
gui-doctor run     <job.json> [--project <dir>]
```

Common options:

| Flag | Meaning |
| --- | --- |
| `--project <dir>` | Project root (sandbox root; default: cwd) |
| `--out <dir>` | Output dir (must live inside `--project`) |
| `--json` | Print the full JSON result instead of a digest |
| `--allow-js` | Permit page JavaScript (probes / init scripts / evaluate) |
| `--har <path>` | Replay network from a recorded HAR (fork/bisect) |
| `--seed <n>` | Seed `Math.random` (mulberry32) |
| `--clock <iso\|ms>` | Freeze the page clock |
| `--container-label <s>` | Label shown by the visible container |
| `--no-container` | Disable the visible container (default: on) |

Run `gui-doctor --help` for the full flag list.

## Artifacts

Everything is written under `<project>/.gui-doctor/` (`runs/`, `jobs/`). Traces are
attached to tool results as `application/zip`.

## Requirements

- Node.js **>= 20**
- Playwright (optional peer dependency) — or a system Chrome/Edge channel
- Chromium for CDP breakpoint probes and the DevTools perf trace

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Release process is documented in
[RELEASING.md](./RELEASING.md).

## License

[MIT](./LICENSE)
