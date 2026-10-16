---
name: gui-diagnostics
description: Use when diagnosing bugs, errors, or flaky behavior in browser/GUI apps (Vue/React/Electron/iframe). Provides trace recording, trace analysis, forked replay probes, and Chrome DevTools CDP inspection via the gui-doctor tools (gui_doctor_env, gui_trace_record, gui_trace_analyze, gui_probe_fork, gui_cdp_inspect).
---

# GUI diagnostics (gui-doctor)

Turn a reproducible GUI failure into a recorded Playwright trace, a structured
digest, and **forked replay probes** that test hypotheses in isolation — instead
of guessing from source alone.

## Install

Distributed as the npm plugin `opencode-gui-doctor` (bundles the plugin, runtime
and this skill). Add it to `opencode.json` and restart opencode:

```json
{ "plugin": ["opencode-gui-doctor"] }
```

Local checkout: `{ "plugin": ["./packages/opencode-gui-doctor/plugin/index.ts"] }`.
The plugin resolves its runtime relative to itself and registers this skill via
`skills.paths`, so it works from any project. `playwright` is an optional peer
dependency — install it in the project being diagnosed.

## When to use

- A UI action errors, renders wrong, or silently fails and the stack trace alone
  is not enough.
- You need console errors, failed network calls, or DOM snapshots around a
  specific click/navigation.
- You want to prove a hypothesis ("does the bug disappear if the API returns
  200?") without editing app code.

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

## Visible container (default on)

Every run wraps the target in a **visible, labelled container** so it is obvious
which window is under test:

- **web** — the app runs inside an `<iframe>` wrapped by a labelled toolbar
  (label · url · status dot · clock) and an accent border. Steps, probes and the
  a11y snapshot are automatically scoped into the app frame; screenshots and
  traces include the wrapper. `X-Frame-Options` / CSP `frame-ancestors` are
  stripped for the app origin so it can be embedded.
- **electron / cdp** — the native window cannot be wrapped in DOM, so a fixed,
  labelled banner + accent border are overlaid on the live page instead
  (element `#gui-doctor-banner`).

Disable per call with `container: false`, or tune it via
`container: { label, accent, border, stripFrameAncestors }`. CLI: `--no-container`.
Note: an iframe changes `window.top !== window.self`, which can alter the
behaviour of a few frame-busting apps — pass `container: false` if you hit that.

State presets: instead of hand-writing probe JS, use `{ "preset": "vue" | "pinia"
| "react" | "storage" }`. Each is best-effort and returns `null` when the
framework/devtools hook is absent. Presets are JavaScript, so they need the same
`allowJsProbes` gate.

The same harness is available as a CLI (`gui-doctor`): `env`, `record`, `fork`,
`bisect`, `cdp`, `analyze`, `run` — e.g.
`gui-doctor record --url http://localhost:1420 --runs 5 --steps steps.json`.

## Workflow

1. `gui_doctor_env` — confirm Playwright + a browser channel.
2. `gui_trace_record` — reproduce the bug with `steps` (e.g. `goto`, `click`,
   `fill`, `expectText`) and read the digest. Common actions:
   `goto|click|dblclick|fill|type|press|hover|check|uncheck|select|setInputFiles|dragTo|reload|goBack|scroll|scrollIntoViewIfNeeded|clear|focus|waitForSelector|waitForTimeout|waitForLoadState|waitForFunction|screenshot|evaluate|expectText|expectVisible|expectCount`.
   `expect*` assertions auto-wait within the step timeout, and each step result
   lists the page errors / console errors / failed requests observed during that
   step, so failures point straight at the offending interaction.
3. `gui_trace_analyze` — drill into the produced `trace.zip` when you need the
   full error/console/network lists.
4. `gui_probe_fork` — form 2+ hypotheses as forks that share a replay prefix.
   Add `probes` reading app state (e.g. `() => window.__PINIA__?.state`), and use
   `routeMocks` / `initScripts` / `patchAfterLoad` to isolate the cause. Compare
   `changedProbes` and `failedStepDelta` against `baseline`.
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

Interpretation: if only `api-500` reproduces the failure, the root cause is the
error path around the API. If `disable-cache` changes behavior, investigate
caching. `diff.diffs[].changedProbes` lists exactly what diverged.

## Advanced diagnosis

- **Flake detection** (`gui_trace_record` → `runs: N`): replays the scenario N
  times, each with a fresh browser, and reports a per-step pass/fail matrix plus
  the flaky steps (those that passed on some runs and failed on others).
  `runConcurrency` runs up to N repeats in parallel. Artifacts are suffixed per
  run (`trace-0.zip`, `final-1.png`, …).
- **Failure evidence** (`capture`): `screenshotOnFailure` screenshots the page at
  the first failing step; `video` records a video (web target, written to
  `video/`); `body` captures failed request/response bodies and `bodyAll`
  captures all responses (bounded, key-aware redaction applies).
- **Parallel forks** (`gui_probe_fork` → `forkConcurrency`): run up to N fork
  variants concurrently (each still launches its own isolated browser). Each
  fork's container label is suffixed with the fork id, so parallel variants are
  visually distinguishable on screen.
- **CDP ownership** (`gui_cdp_inspect` → `closeOnExit`): by default the attached
  browser is left running; `closeOnExit: true` kills it via raw CDP on exit.
- **Artifact retention** (`.gui-doctor.json` → `retention`): `{ "maxRuns": 20 }`
  prunes old `runs/` directories (oldest first) and `{ "maxAuditBytes": 5242880 }`
  halves `audit.log` once it grows past the cap. These are the defaults.
- **Deterministic forks** (`gui_probe_fork` / `gui_bisect` → `determinism`):
  record once with `{ "record": true }` to write `network.har`, then replay with
  `{ "harPath": ".../network.har" }` so forks see identical upstream responses.
  `seed` fixes `Math.random`; `clockTime` freezes the page clock. All three are
  honoured by record, fork **and** bisect; explicit `routeMocks` win over HAR
  replay. Together they make variants differ only by the hypothesis.
- **CDP breakpoint probes** (`breakpointProbes` on `gui_trace_record`): pause at a
  script `url`/`urlRegex` + `line` and read locals/scope via
  `evaluateOnCallFrame`, e.g.
  `[{ "urlRegex": "app\\.js", "line": 42, "expressions": ["state", "this.value"] }]`.
  Auto-resumes (with a safety timeout); Chromium only.
- **Response bodies**: `capture.body` records failed request/response bodies
  (key-aware redaction applies).
- **Source maps**: stacks are best-effort mapped back to `.ts`/`.vue` via sibling
  `.map` files (disable with `resolveStacks: false`).
- **Visual + a11y diff**: `gui_probe_fork` reports changed-pixel ratio and an
  accessibility-tree line diff vs the `baseline` fork.
- **Auto-bisect** (`gui_bisect`): localize the first divergent step; give an
  `afterEachProbe` (expression/preset) and optional `until` predicate.

## Security policy (default-safe)

The plugin is **default-deny** and applied equally by the plugin (permission
gating) and the harness (enforcement):

- **No JavaScript injection by default.** `probes`, `initScripts`, `routeMocks`,
  `patchAfterLoad`, and `evaluate` steps are refused unless `allowJsProbes` is
  enabled. On demand the plugin asks for permission (`gui.evaluate`) and grants
  it for that run only.
- **Outbound allowlist.** Navigation is limited to `localhost / 127.0.0.1 /
  [::1]` by default; anything else asks for `gui.navigate`. Same for CDP
  endpoints (`gui.cdp`).
- **Filesystem sandbox.** `initScripts` paths, `storageState`, `outputDir` and
  Electron executables must live inside the project root (or `allowedPaths`).
- **Redaction.** Console text, page errors, probe results and network URLs are
  scrubbed of secrets (Authorization/Cookie/JWT/Bearer/AWS/GitHub tokens +
  sensitive key names) before anything is returned to the model.
- **Raw traces are not attached by default** (they can contain secrets). The
  redacted `diagnostics.json` is attached instead; the `trace.zip` is still
  written and its path printed.
- **Audit log.** Every run, navigation and JS grant is appended to
  `.gui-doctor/audit.log`.
- **Timeouts.** A hard harness timeout prevents hung browsers.

Configure via `.gui-doctor.json` in the project, plugin options, or env vars:

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

## MCP servers

`opencode.json` registers **playwright** (`@playwright/mcp`) and
**chrome-devtools** (`chrome-devtools-mcp`) MCP servers for ad-hoc exploration
in addition to these higher-level tools. To have the plugin auto-register them
instead, load it with `["guidoctor", { "registerMcp": true }]` or set
`GUI_DOCTOR_REGISTER_MCP=1`.

## Artifacts

Everything is written under `<project>/.gui-doctor/` (`runs/`, `jobs/`).
Traces are attached to tool results as `application/zip`.
