import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveModule, importModule, ensureDir, readJson, writeJson, truncate, nowIso, normalizeExpression, withTimeout, detectBrowserChannel, emitProgress } from "./lib/util.mjs"
import { mergePolicy, isUrlAllowed, isEndpointAllowed, isPathAllowed, redactValue, limitValue, createAuditor, pruneArtifacts } from "./lib/policy.mjs"
import { resolveProbeExpression } from "./lib/presets.mjs"
import { seedInitScript, loadHar, makeHarHandler } from "./lib/determinism.mjs"
import { installBreakpointProbes, disposeBreakpointProbes } from "./lib/probes-cdp.mjs"
import { fetchJson, CDP } from "./lib/cdp.mjs"
import { resolveStack, makeContextFetcher } from "./lib/sourcemap.mjs"
import { a11ySnapshot, diffText } from "./lib/a11y.mjs"
import { diffPng } from "./lib/pngdiff.mjs"
import { resolveContainer, installWebContainer, installBanner, stripFrameGuards, evalInApp, frameSelector } from "./lib/container.mjs"

const selfDir = path.dirname(fileURLToPath(import.meta.url))
import { runStep, runSteps } from "./lib/actions.mjs"
import { analyzeTrace } from "./lib/trace-analyze.mjs"

const [jobFile, outFile] = process.argv.slice(2)

function log(...args) {
  process.stderr.write(`${args.join(" ")}\n`)
}

function fail(out, error) {
  const payload = { ok: false, error: error && error.message ? error.message : String(error), stack: error?.stack, finishedAt: nowIso() }
  if (out) writeJson(out, payload)
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  log(`[gui-doctor] ERROR ${payload.error}`)
  process.exit(1)
}

async function loadPlaywright(projectDir) {
  const roots = [projectDir, process.cwd(), selfDir, process.env.GUI_DOCTOR_PLUGIN_ROOT].filter(Boolean)
  const resolved = resolveModule(["playwright", "playwright-core", "@playwright/test"], roots)
  const mod = await importModule(resolved.path)
  return mod.default ?? mod
}

function attachCollectors(page, bucket, capture = {}) {
  const maxBody = capture.maxBodyBytes ?? 8192
  page.on("console", (msg) => {
    if (capture.console === false) return
    const loc = msg.location ? `${msg.location().url ?? ""}:${msg.location().lineNumber ?? ""}` : null
    bucket.console.push({ level: msg.type(), text: truncate(msg.text(), 2000), location: loc, ts: Date.now() })
  })
  page.on("pageerror", (err) => {
    if (capture.pageErrors === false) return
    bucket.pageErrors.push({ message: truncate(err.message, 2000), stack: truncate(err.stack, 4000), ts: Date.now() })
  })
  page.on("requestfailed", (req) => {
    if (capture.network === false) return
    const entry = { method: req.method(), url: req.url(), failure: req.failure()?.errorText ?? "failed", status: null, ts: Date.now() }
    if (capture.body) {
      try {
        const data = req.postData()
        if (data) entry.requestBody = truncate(data, maxBody)
      } catch {
        /* ignore */
      }
    }
    bucket.requests.push(entry)
  })
  page.on("response", async (res) => {
    if (capture.network === false) return
    const status = res.status()
    const failed = status >= 400
    // By default only failures are recorded; bodyAll also records successful
    // responses (bounded) so their payloads are available for analysis.
    if (!failed && !capture.bodyAll) return
    const entry = { method: res.request().method(), url: res.url(), status, failure: null, ts: Date.now() }
    if (capture.body || capture.bodyAll) {
      try {
        const data = res.request().postData()
        if (data) entry.requestBody = truncate(data, maxBody)
      } catch {
        /* ignore */
      }
      try {
        const body = await res.body()
        if (body) entry.responseBody = truncate(body.toString("utf8"), maxBody)
      } catch {
        /* ignore */
      }
    }
    bucket.requests.push(entry)
  })
}

function newBucket() {
  return { console: [], pageErrors: [], requests: [] }
}

// Attach the errors / failed requests observed during a step to the step
// result, so each step directly answers "what went wrong here". Correlation is
// exact: `marks` records the bucket array lengths at step start (via onStepStart)
// and the step's events are the slice from those marks to the current lengths.
function correlateStepEvents(bucket, marks) {
  return (res) => {
    const slice = (arr, from) => (arr ?? []).slice(from)
    const consoleErrors = slice(bucket.console, marks.console).filter((c) => c.level === "error").map((c) => truncate(c.text ?? "", 200))
    const pageErrors = slice(bucket.pageErrors, marks.pageErrors).map((e) => truncate(e.message ?? "", 200))
    const failedRequests = slice(bucket.requests, marks.requests)
      .filter((r) => (r.status != null && r.status >= 400) || r.failure)
      .map((r) => `${r.status ?? "ERR"} ${r.method} ${truncate(r.url ?? "", 160)}`)
    if (consoleErrors.length || pageErrors.length || failedRequests.length) {
      res.events = {
        consoleErrors: consoleErrors.slice(0, 5),
        pageErrors: pageErrors.slice(0, 5),
        failedRequests: failedRequests.slice(0, 5),
      }
    }
  }
}

// Snapshot the bucket lengths so the next step's correlation slice is exact.
function markBucket(bucket) {
  return { console: bucket.console.length, pageErrors: bucket.pageErrors.length, requests: bucket.requests.length }
}

// Key-aware redaction of captured request/response bodies (JSON-aware).
function redactBodies(result, policy) {
  if (!policy?.redaction?.enabled) return
  const buckets = [result?.events, ...(result?.forks ?? []).map((f) => f?.events)].filter(Boolean)
  for (const ev of buckets) {
    if (!Array.isArray(ev.requests)) continue
    for (const r of ev.requests) {
      for (const key of ["requestBody", "responseBody"]) {
        if (typeof r[key] !== "string") continue
        try {
          r[key] = JSON.stringify(redactValue(JSON.parse(r[key]), policy))
        } catch {
          r[key] = redactValue(r[key], policy)
        }
      }
    }
  }
}

class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = "PolicyError"
  }
}

function collectNavUrls(job) {
  const urls = []
  if (job.url) urls.push(job.url)
  const scan = (steps) => {
    for (const s of steps ?? []) {
      if (s?.action === "goto" || s?.action === "navigate") urls.push(s.value ?? s.url)
      else if (s?.action === "waitForURL") urls.push(s.value ?? s.url)
    }
  }
  scan(job.steps)
  for (const fork of job.forks ?? []) scan(fork.steps)
  return urls.filter(Boolean)
}

function jsFeaturesRequested(job) {
  const stepsHaveEval = (steps) => (steps ?? []).some((s) => s?.action === "evaluate" || s?.action === "eval")
  return (
    (job.probes ?? []).length > 0 ||
    (job.initScripts ?? []).length > 0 ||
    (job.routeMocks ?? []).length > 0 ||
    stepsHaveEval(job.steps) ||
    !!((job.breakpointProbes ?? []).length || job.afterEachProbe || job.until) ||
    (job.forks ?? []).some((f) => (f.probes ?? []).length || (f.initScripts ?? []).length || (f.patchAfterLoad ?? []).length || stepsHaveEval(f.steps))
  )
}

function assertPolicy(job, policy) {
  const roots = [job.projectDir, ...(policy.allowedPaths ?? [])].filter(Boolean)

  for (const url of collectNavUrls(job)) {
    if (!isUrlAllowed(url, policy)) {
      throw new PolicyError(`navigation to '${url}' is outside allowedOrigins [${(policy.allowedOrigins ?? []).join(", ")}]`)
    }
  }

  if (jsFeaturesRequested(job) && !policy.allowJsProbes) {
    throw new PolicyError("this run injects JavaScript (probes/initScripts/routeMocks/evaluate); enable allowJsProbes in policy to permit it")
  }

  // Defense in depth: the CDP endpoint allowed by the plugin's gate must also
  // pass the harness-side allowlist (mirrors cdp-perf.mjs).
  if (job.target === "cdp" && job.cdp?.endpoint && !isEndpointAllowed(job.cdp.endpoint, policy)) {
    throw new PolicyError(`CDP endpoint '${job.cdp.endpoint}' is outside cdpAllowedEndpoints [${(policy.cdpAllowedEndpoints ?? []).join(", ")}]`)
  }

  const pathInputs = []
  for (const s of job.initScripts ?? []) if (typeof s === "string" && fs.existsSync(s)) pathInputs.push(s)
  for (const f of job.forks ?? []) for (const s of f.initScripts ?? []) if (typeof s === "string" && fs.existsSync(s)) pathInputs.push(s)
  if (job.launch?.storageState) pathInputs.push(job.launch.storageState)
  if (job.electron?.executablePath) pathInputs.push(job.electron.executablePath)
  if (job.outputDir) pathInputs.push(job.outputDir)

  for (const p of pathInputs) {
    if (p && !isPathAllowed(p, roots)) {
      throw new PolicyError(`path '${p}' is outside the sandbox (project dir + allowedPaths)`)
    }
  }
}

function finalizeResult(result, policy, audit, meta) {
  if (policy.redaction?.enabled) {
    redactBodies(result, policy)
    result.events = redactValue(result.events, policy)
    result.probes = redactValue(result.probes, policy)
    result.steps = redactValue(result.steps, policy)
    result.diagnostics = redactValue(result.diagnostics, policy)
    result.forks = redactValue(result.forks, policy)
  }
  const capped = limitValue(result, policy.redaction?.maxTotalBytes)
  if (capped?.truncated) {
    const keep = { ok: result.ok, mode: result.mode, target: result.target, outputDir: result.outputDir, traceFile: result.traceFile, durationMs: result.durationMs, finishedAt: result.finishedAt, truncated: true, ...capped.value }
    audit?.({ event: "result-truncated", tool: meta?.tool })
    return keep
  }
  return result
}

async function runProbes(page, probes, bucket, container) {
  const results = []
  for (const probe of probes ?? []) {
    const name = probe.name ?? `probe_${results.length}`
    const started = Date.now()
    try {
      const code = normalizeExpression(resolveProbeExpression(probe) ?? probe.function)
      const value = container?.kind === "iframe" ? await evalInApp(page, container, code) : await page.evaluate(code)
      results.push({ name, ok: true, value: normalizeEvalValue(value), durationMs: Date.now() - started })
    } catch (err) {
      results.push({ name, ok: false, error: err?.message ?? String(err), durationMs: Date.now() - started })
    }
  }
  return results
}

function normalizeEvalValue(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

async function launchWeb(pw, job) {
  const launch = job.launch ?? {}
  const options = {
    headless: launch.headless !== false,
    channel: launch.channel || undefined,
    executablePath: launch.executablePath || undefined,
    slowMo: launch.slowMo ?? 0,
    args: launch.args ?? [],
  }
  let browser
  try {
    browser = await pw.chromium.launch(options)
  } catch (err) {
    const suggestion = detectBrowserChannel().channelSuggestion
    if (!launch.channel && !launch.executablePath && suggestion && /executable doesn't exist|browserType.launch|Failed to launch/i.test(err.message)) {
      log(`[gui-doctor] bundled chromium unavailable, falling back to channel '${suggestion}'`)
      browser = await pw.chromium.launch({ ...options, channel: suggestion })
    } else {
      throw err
    }
  }
  const viewport = launch.viewport ?? { width: 1280, height: 720 }
  const contextOptions = {
    viewport,
    deviceScaleFactor: launch.deviceScaleFactor ?? 1,
    storageState: launch.storageState || undefined,
  }
  if (job.capture?.video) {
    contextOptions.recordVideo = { dir: path.join(job.outputDir, "video"), size: { width: viewport.width, height: viewport.height } }
  }
  if (job.determinism?.record && job.outputDir) {
    contextOptions.recordHar = { path: path.join(job.outputDir, job.determinism.recordFileName ?? "network.har"), content: "embed", mode: "full" }
  }
  const context = await browser.newContext(contextOptions)
  return { browser, context, ownsBrowser: true }
}

async function attachCdp(pw, job) {
  const endpoint = job.cdp?.endpoint ?? "http://127.0.0.1:9222"
  const browser = await pw.chromium.connectOverCDP(endpoint)
  const contexts = browser.contexts()
  // Prefer the context that owns a page matching `match` (multiple contexts are
  // common with Electron / multiple browser profiles).
  const match = job.cdp?.match
  let context = contexts[0]
  if (match) {
    for (const c of contexts) {
      if ((c.pages() ?? []).some((p) => (p.url() || "").includes(match))) {
        context = c
        break
      }
    }
  }
  return { browser, context: context ?? (await browser.newContext()), ownsBrowser: true }
}

// Choose the page to operate on, honouring `cdp.match` when several are open.
function pickPage(context, job) {
  const pages = context?.pages?.() ?? []
  const match = job.target === "cdp" ? job.cdp?.match : undefined
  if (match) {
    const hit = pages.find((p) => (p.url() || "").includes(match))
    if (hit) return hit
  }
  return pages[0]
}

async function launchElectron(pw, job) {
  const electron = job.electron ?? {}
  const app = await pw._electron.launch({ args: electron.args ?? [], executablePath: electron.executablePath || undefined })
  const page = await app.firstWindow()
  return { app, context: page.context(), page, ownsBrowser: true }
}

async function startTrace(context, trace, file) {
  if (trace?.enabled === false) return null
  await context.tracing.start({
    screenshots: trace?.screenshots !== false,
    snapshots: trace?.snapshots !== false,
    sources: trace?.sources !== false,
    title: trace?.title,
  })
  return file
}

async function stopTrace(context, traceFile) {
  if (!traceFile) return null
  ensureDir(path.dirname(traceFile))
  await context.tracing.stop({ path: traceFile })
  return traceFile
}

async function applyRouteMocks(context, mocks) {
  for (const mock of mocks ?? []) {
    await context.route(mock.url, async (route) => {
      if (mock.abort) return route.abort(mock.abort === true ? "failed" : mock.abort)
      await route.fulfill({
        status: mock.status ?? 200,
        contentType: mock.contentType ?? "application/json",
        body: typeof mock.body === "string" ? mock.body : JSON.stringify(mock.body ?? {}),
        headers: mock.headers,
      })
    })
  }
}

async function applyInitScripts(context, scripts) {
  for (const raw of scripts ?? []) {
    const code = raw && fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw
    await context.addInitScript({ content: code })
  }
}

// Seed randomness, HAR-backed network replay and a frozen clock so variants
// differ only by the hypothesis under test. Shared by record / fork / bisect so
// every mode honours the same determinism options.
async function installDeterminism(context, page, job, harStats) {
  const det = job.determinism
  if (!det) return
  if (det.seed != null) await context.addInitScript({ content: seedInitScript(det.seed) })
  if (det.harPath && fs.existsSync(det.harPath)) {
    const har = loadHar(det.harPath)
    await context.route("**/*", makeHarHandler(har, harStats ?? { served: 0, passed: 0 }))
  }
  if (det.clockTime != null && page?.clock?.install) {
    try {
      await page.clock.install({ time: typeof det.clockTime === "number" ? det.clockTime : new Date(det.clockTime).getTime() })
    } catch {
      /* clock API unavailable */
    }
  }
}

// Bounded-concurrency map (fork variants each launch their own browser).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const size = Math.max(1, Math.min(limit, items.length || 1))
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// Aggregate per-step pass/fail across repeated runs to surface flakiness.
function computeFlake(runResults) {
  const n = runResults.length
  const maxSteps = Math.max(0, ...runResults.map((r) => (r.steps ?? []).length))
  const stepStats = []
  for (let i = 0; i < maxSteps; i++) {
    let pass = 0
    let fail = 0
    let action = null
    for (const r of runResults) {
      const s = (r.steps ?? [])[i]
      if (!s) continue
      action = s.action
      if (s.ok) pass++
      else fail++
    }
    stepStats.push({ index: i, action, pass, fail, flaky: pass > 0 && fail > 0 })
  }
  const flakySteps = stepStats.filter((s) => s.flaky)
  const failedRuns = runResults.filter((r) => !r.ok || (r.steps ?? []).some((s) => !s.ok)).length
  return { runs: n, failedRuns, flakeRate: n ? +(failedRuns / n).toFixed(4) : 0, flakySteps, stepStats }
}

async function resolveDiagnostics(context, result, job) {
  if (job.resolveStacks === false || !context?.request) return
  const fetchMap = makeContextFetcher(context.request)
  const cache = new Map()
  const targets = [...(result.diagnostics?.pageErrors ?? []), ...(result.errors ?? [])].filter((e) => e.stack).slice(0, 5)
  for (const e of targets) {
    try {
      const { mappedStack, frames } = await resolveStack(e.stack, { fetchMap, cache })
      if (frames.some((f) => f.original)) e.mappedStack = mappedStack
    } catch {
      /* best-effort */
    }
  }
}

function resolveSteps(job) {
  const steps = [...(job.steps ?? [])]
  // With an iframe container the app is loaded by the wrapper, so we must not
  // prepend a page-level goto (which would navigate the container itself away).
  const wrapped = resolveContainer(job)?.kind === "iframe"
  if (job.url && !wrapped && steps[0]?.action !== "goto" && steps[0]?.action !== "navigate") {
    steps.unshift({ action: "goto", value: job.url, waitUntil: "load", waitForIdle: job.waitForIdle })
  }
  return steps
}

// Wrap the target in its visible container (iframe for web, banner overlay for
// electron/cdp) and return the resolved config for step/probe scoping.
async function setupContainer(page, context, job) {
  const container = resolveContainer(job)
  if (!container) return null
  emitProgress({ phase: "container", kind: container.kind, target: container.target, label: container.label })
  if (container.kind === "iframe") {
    if (container.stripFrameAncestors && job.url) await stripFrameGuards(context, job.url)
    await installWebContainer(page, container, job.url, { timeout: job.launch?.timeout ?? 20000 })
  } else {
    await installBanner(page, context, container, job)
  }
  return container
}

function a11yRoot(page, container) {
  return container?.kind === "iframe" ? page.frameLocator(frameSelector(container)) : page
}

async function recordOnce(pw, job, { runIndex = 0, runs = 1 } = {}) {
  const started = Date.now()
  const steps = resolveSteps(job)
  const outDir = job.outputDir
  // With runs>1, write one HAR per run instead of every run clobbering the same file.
  const launchJob = runs > 1 && job.determinism?.record ? { ...job, determinism: { ...job.determinism, recordFileName: (job.determinism.recordFileName ?? "network.har").replace(/\.har$/i, `-${runIndex}.har`) } } : job
  const { browser, context, app, page: electronPage, ownsBrowser, dispose } = await launchForTarget(pw, launchJob)
  const bucket = newBucket()
  const suffix = runs > 1 ? `-${runIndex}` : ""
  const traceFile = path.join(outDir, job.trace?.fileName ?? `trace${suffix}.zip`)
  const out = { ok: true }
  const videoDir = job.capture?.video ? path.join(outDir, "video") : null

  const bpProbes = { results: [], errors: [] }
  try {
    await startTrace(context, job.trace, traceFile)
    let page = electronPage ?? pickPage(context, job) ?? (await context.newPage())
    attachCollectors(page, bucket, job.capture)
    context.on("page", (p) => attachCollectors(p, bucket, job.capture))

    await applyInitScripts(context, job.initScripts)
    await installDeterminism(context, page, job)
    const container = await setupContainer(page, context, job)
    if (container) out.container = { kind: container.kind, label: container.label, accent: container.accent }
    await applyRouteMocks(context, job.routeMocks)

    const installed = await installBreakpointProbes(page, job.breakpointProbes, { log })
    bpProbes.results = installed.results
    bpProbes.errors = installed.errors
    bpProbes.session = installed.session

    const recordMarks = markBucket(bucket)
    const stepResults = await runSteps(page, steps, {
      defaultTimeout: job.launch?.timeout ?? 15000,
      stopOnFailure: job.stopOnFailure !== false,
      screenshotPath: job.capture?.screenshotEachStep ? (i) => path.join(outDir, `step-${i}${suffix}.png`) : undefined,
      screenshotOnFailure: job.capture?.screenshotOnFailure ? (i) => path.join(outDir, `failure-${i}${suffix}.png`) : undefined,
      container,
      onStepStart: () => {
        recordMarks.console = bucket.console.length
        recordMarks.pageErrors = bucket.pageErrors.length
        recordMarks.requests = bucket.requests.length
      },
      onStep: (res, i) => {
        correlateStepEvents(bucket, recordMarks)(res)
        emitProgress({ phase: "step", index: i, total: steps.length, action: res.action, ok: res.ok, error: res.error || undefined, durationMs: res.durationMs })
      },
    })
    if ((job.probes ?? []).length) emitProgress({ phase: "probes", count: job.probes.length })
    const probeResults = await runProbes(page, job.probes, bucket, container)

    try {
      out.a11y = await a11ySnapshot(a11yRoot(page, container))
    } catch {
      /* ignore */
    }
    try {
      await page.screenshot({ path: path.join(outDir, `final${suffix}.png`) })
    } catch {
      /* page may be closed */
    }

    const writtenTrace = await stopTrace(context, job.trace?.enabled === false ? null : traceFile)
    out.steps = stepResults
    out.probes = probeResults
    out.events = bucket
    out.traceFile = writtenTrace
    if (bpProbes.results.length || bpProbes.errors.length) {
      out.breakpointProbes = bpProbes.results
      out.breakpointProbeErrors = bpProbes.errors
    }
    if (writtenTrace && fs.existsSync(writtenTrace)) {
      try {
        out.diagnostics = analyzeTrace(writtenTrace)
      } catch (err) {
        out.diagnosticsError = err.message
      }
    }
    await resolveDiagnostics(context, out, job)
  } catch (err) {
    out.ok = false
    out.error = err?.message ?? String(err)
  } finally {
    await disposeBreakpointProbes(bpProbes)
    // context.close() 会关掉真实页面：仅在自管浏览器时执行。
    // browser.close()：自管=关闭进程；CDP 附加=仅断开连接（Playwright 语义，实测浏览器存活）。
    if (ownsBrowser && context && (job.target ?? "web") === "web") await context.close().catch(() => {})
    if (app) await app.close().catch(() => {})
    else if (browser) await browser.close().catch(() => {})
    if (dispose) await dispose().catch(() => {})
    if (videoDir && fs.existsSync(videoDir)) {
      try {
        out.videoFiles = fs.readdirSync(videoDir).map((f) => path.join(videoDir, f))
      } catch {
        /* ignore */
      }
    }
  }
  out.durationMs = Date.now() - started
  return out
}

async function runRecord(pw, job, result) {
  const runs = Math.max(1, Math.min(50, Number(job.runs) || 1))
  if (runs === 1) {
    Object.assign(result, await recordOnce(pw, job, { runIndex: 0, runs: 1 }))
    return
  }
  emitProgress({ phase: "start", mode: "record", target: job.target ?? "web", runs })
  // Optionally run repeats with bounded concurrency (each is a fresh browser).
  const limit = Math.max(1, Math.min(8, Number(job.runConcurrency) || 1))
  const indices = Array.from({ length: runs }, (_, i) => i)
  const all = await mapPool(indices, limit, (i) => {
    emitProgress({ phase: "run", index: i, total: runs })
    return recordOnce(pw, job, { runIndex: i, runs })
  })
  Object.assign(result, all[0])
  result.runs = all.map((r, i) => ({
    index: i,
    ok: r.ok,
    error: r.error ?? null,
    failedSteps: (r.steps ?? []).filter((s) => !s.ok).length,
    durationMs: r.durationMs,
    traceFile: r.traceFile ?? null,
  }))
  result.flake = computeFlake(all)
  result.runCount = runs
  result.ok = all.every((r) => r.ok) && result.flake.flakySteps.length === 0
  log(`[gui-doctor] flake: ${result.flake.failedRuns}/${runs} runs failed, ${result.flake.flakySteps.length} flaky step(s)`)
}

async function runOneFork(pw, job, fork, idx, total, outDir, harStats) {
  const steps = resolveSteps(job)
  const forkAt = Math.min(fork.forkAt ?? steps.length, steps.length)
  const prefix = steps.slice(0, forkAt)
  const divergence = [...(fork.steps ?? []), ...steps.slice(forkAt)]
  const bucket = newBucket()
  const entry = { id: fork.id ?? `fork_${idx}`, forkAt, ok: true }
  const traceFile = path.join(outDir, `trace-${entry.id}.zip`)
  emitProgress({ phase: "fork", id: entry.id, index: idx, total, prefixSteps: prefix.length, divergingSteps: divergence.length })

  let browser
  let context
  let app
  let ownsBrowser = true
  let dispose
  try {
    const launched = await launchForTarget(pw, job)
    browser = launched.browser
    context = launched.context
    app = launched.app
    ownsBrowser = launched.ownsBrowser !== false
    dispose = launched.dispose

    await applyInitScripts(context, [...(job.initScripts ?? []), ...(fork.initScripts ?? [])])
    await startTrace(context, job.trace, job.trace?.enabled === false ? null : traceFile)

    let page = launched.page ?? pickPage(context, job) ?? (await context.newPage())
    attachCollectors(page, bucket, job.capture)
    context.on("page", (p) => attachCollectors(p, bucket, job.capture))

    // Determinism (seed/HAR/clock) is registered before the container and mocks
    // so explicit routeMocks (registered last) take precedence over HAR replay.
    await installDeterminism(context, page, job, harStats)
    // Label the container with the fork id so parallel variants are visually
    // distinguishable on screen.
    const forkJob = entry.id
      ? { ...job, container: job.container === false ? false : { ...(typeof job.container === "object" && job.container ? job.container : {}), label: `${resolveContainer(job)?.label ?? "gui-doctor"} · ${entry.id}` } }
      : job
    const container = await setupContainer(page, context, forkJob)
    await applyRouteMocks(context, [...(job.routeMocks ?? []), ...(fork.routeMocks ?? [])])

    const forkMarks = markBucket(bucket)
    const onForkStep = (phaseTotal) => (res, i) => {
      correlateStepEvents(bucket, forkMarks)(res)
      emitProgress({ phase: "step", forkId: entry.id, index: i, total: phaseTotal, action: res.action, ok: res.ok, error: res.error || undefined })
    }
    const prefixResults = await runSteps(page, prefix, { defaultTimeout: job.launch?.timeout ?? 15000, stopOnFailure: true, container, onStepStart: () => { forkMarks.console = bucket.console.length; forkMarks.pageErrors = bucket.pageErrors.length; forkMarks.requests = bucket.requests.length }, onStep: onForkStep(prefix.length) })

    for (const patch of fork.patchAfterLoad ?? []) {
      try {
        await (container?.kind === "iframe" ? evalInApp(page, container, normalizeExpression(patch.expression ?? patch.function)) : page.evaluate(normalizeExpression(patch.expression ?? patch.function)))
      } catch (err) {
        entry.patchError = err.message
      }
    }

    const divResults = await runSteps(page, divergence, { defaultTimeout: job.launch?.timeout ?? 15000, stopOnFailure: job.stopOnFailure !== false, container, onStepStart: () => { forkMarks.console = bucket.console.length; forkMarks.pageErrors = bucket.pageErrors.length; forkMarks.requests = bucket.requests.length }, onStep: onForkStep(divergence.length) })
    if ((fork.probes ?? []).length) emitProgress({ phase: "probes", forkId: entry.id, count: fork.probes.length })
    const probeResults = await runProbes(page, fork.probes ?? [], bucket, container)

    entry.screenshotPath = path.join(outDir, `fork-${entry.id}.png`)
    try {
      entry.a11y = await a11ySnapshot(a11yRoot(page, container))
    } catch {
      /* ignore */
    }
    try {
      await page.screenshot({ path: entry.screenshotPath })
    } catch {
      entry.screenshotPath = null
    }

    const writtenTrace = await stopTrace(context, job.trace?.enabled === false ? null : traceFile)
    entry.steps = [...prefixResults, ...divResults]
    entry.probes = probeResults
    entry.events = bucket
    entry.traceFile = writtenTrace
    entry.failedSteps = entry.steps.filter((s) => !s.ok).length
    if (writtenTrace && fs.existsSync(writtenTrace)) {
      try {
        entry.diagnostics = analyzeTrace(writtenTrace).summary
      } catch (err) {
        entry.diagnosticsError = err.message
      }
    }
  } catch (err) {
    entry.ok = false
    entry.error = err?.message ?? String(err)
  } finally {
    if (ownsBrowser && context && (job.target ?? "web") === "web") await context.close().catch(() => {})
    if (app) await app.close().catch(() => {})
    else if (browser) await browser.close().catch(() => {})
    if (dispose) await dispose().catch(() => {})
  }
  emitProgress({ phase: "fork-done", id: entry.id, index: idx, total, ok: entry.ok, failedSteps: entry.failedSteps })
  log(`[gui-doctor] fork ${entry.id}: ${entry.ok ? "ok" : "failed"} (${entry.failedSteps ?? "?"} failed steps)`)
  return entry
}

async function runFork(pw, job, result) {
  const outDir = job.outputDir
  const forks = job.forks ?? []
  const harStats = { served: 0, passed: 0 }
  const limit = Math.max(1, Math.min(8, Number(job.forkConcurrency) || 1))
  result.forks = []
  const entries = await mapPool(forks, limit, (fork, idx) => runOneFork(pw, job, fork, idx, forks.length, outDir, harStats))
  result.forks = entries
  result.diff = diffForks(entries, outDir)
  result.har = harStats
}

// Replays steps one at a time, evaluating a probe after each, and reports the
// first step at which the scenario "fails" (or a user predicate becomes true).
async function runBisect(pw, job, result) {
  const outDir = job.outputDir
  const steps = resolveSteps(job)
  const { browser, context, app, page: electronPage, ownsBrowser, dispose } = await launchForTarget(pw, job)
  const bucket = newBucket()
  const harStats = { served: 0, passed: 0 }

  try {
    await applyInitScripts(context, job.initScripts)
    const page = electronPage ?? pickPage(context, job) ?? (await context.newPage())
    attachCollectors(page, bucket, job.capture)
    await installDeterminism(context, page, job, harStats)
    const container = await setupContainer(page, context, job)
    await applyRouteMocks(context, job.routeMocks)

    const iterations = []
    let culprit = null
    for (let i = 0; i < steps.length; i++) {
      const stepResult = await runStep(page, steps[i], { index: i, defaultTimeout: job.launch?.timeout ?? 15000, container })
      emitProgress({ phase: "bisect", index: i, total: steps.length, action: steps[i].action, ok: stepResult.ok, error: stepResult.error || undefined })
      let probe = null
      if (job.afterEachProbe) {
        try {
          const code = normalizeExpression(resolveProbeExpression(job.afterEachProbe))
          probe = normalizeEvalValue(container?.kind === "iframe" ? await evalInApp(page, container, code) : await page.evaluate(code))
        } catch (err) {
          probe = { error: err.message }
        }
      }
      let matched = false
      if (job.until) {
        try {
          matched = booleanize(container?.kind === "iframe" ? await evalInApp(page, container, normalizeExpression(job.until)) : await page.evaluate(normalizeExpression(job.until)))
        } catch {
          matched = false
        }
      } else {
        matched = !stepResult.ok
      }
      iterations.push({ index: i, action: steps[i].action, stepOk: stepResult.ok, stepError: stepResult.error, probe, matched })
      if (matched) {
        culprit = i
        break
      }
    }

    result.iterations = iterations
    result.culprit = culprit
    result.culpritStep = culprit != null ? steps[culprit] : null
    try {
      result.a11y = await a11ySnapshot(a11yRoot(page, container))
    } catch {
      /* ignore */
    }
    try {
      await page.screenshot({ path: path.join(outDir, "bisect.png") })
    } catch {
      /* ignore */
    }
  } finally {
    if (ownsBrowser && context && (job.target ?? "web") === "web") await context.close().catch(() => {})
    if (app) await app.close().catch(() => {})
    else if (browser) await browser.close().catch(() => {})
    if (dispose) await dispose().catch(() => {})
  }
}

function booleanize(v) {
  if (typeof v === "string") return v !== "" && v !== "false"
  return !!v
}

function diffForks(forkResults, outDir) {
  if (forkResults.length < 1) return null
  const baseline = forkResults.find((f) => f.id === "baseline") ?? forkResults[0]
  const diffs = []
  for (const fork of forkResults) {
    if (fork === baseline) continue
    const probeDiff = []
    const names = new Set([...(baseline.probes ?? []).map((p) => p.name), ...(fork.probes ?? []).map((p) => p.name)])
    for (const name of names) {
      const bp = (baseline.probes ?? []).find((p) => p.name === name)
      const cand = (fork.probes ?? []).find((p) => p.name === name)
      const a = JSON.stringify(bp?.value ?? bp?.error ?? null)
      const b = JSON.stringify(cand?.value ?? cand?.error ?? null)
      if (a !== b) probeDiff.push({ name, baseline: bp?.value ?? bp?.error ?? null, candidate: cand?.value ?? cand?.error ?? null })
    }

    let a11yDiff = null
    if (baseline.a11y != null && fork.a11y != null) a11yDiff = diffText(baseline.a11y, fork.a11y)

    let visualDiff = null
    if (baseline.screenshotPath && fork.screenshotPath && fs.existsSync(baseline.screenshotPath) && fs.existsSync(fork.screenshotPath)) {
      try {
        visualDiff = diffPng(baseline.screenshotPath, fork.screenshotPath, { diffPath: path.join(outDir, `diff-${fork.id}.png`) })
      } catch (err) {
        visualDiff = { error: err.message }
      }
    }

    diffs.push({
      baselineId: baseline.id,
      forkId: fork.id,
      changedProbes: probeDiff,
      consoleDelta: (fork.events?.console?.length ?? 0) - (baseline.events?.console?.length ?? 0),
      pageErrorDelta: (fork.events?.pageErrors?.length ?? 0) - (baseline.events?.pageErrors?.length ?? 0),
      failedStepDelta: (fork.failedSteps ?? 0) - (baseline.failedSteps ?? 0),
      a11yDiff,
      visualDiff,
    })
  }
  return { baselineId: baseline.id, diffs }
}

// Kill a real (CDP-attached) browser — only invoked when the caller explicitly
// opts in via cdp.closeOnExit === true. Playwright's browser.close() merely
// disconnects from an attached browser, so Browser.close goes over raw CDP.
async function killBrowserOverCdp(endpoint) {
  if (!endpoint || /^wss?:\/\//i.test(String(endpoint))) return
  const base = String(endpoint).replace(/\/+$/, "")
  const info = await fetchJson(`${base}/json/version`)
  if (!info?.webSocketDebuggerUrl) return
  const client = new CDP(info.webSocketDebuggerUrl)
  await client.connect()
  try {
    await client.send("Browser.close")
  } finally {
    client.close()
  }
}

// Target adapters: { name: async (pw, job) => { browser?, context, page?, app?, ownsBrowser, dispose? } }.
// Additive — register new targets here without touching the runner.
const TARGETS = {
  web: async (pw, job) => {
    const { browser, context } = await launchWeb(pw, job)
    return { browser, context, ownsBrowser: true }
  },
  cdp: async (pw, job) => {
    const { browser, context } = await attachCdp(pw, job)
    const closeOnExit = job.cdp?.closeOnExit === true
    // A CDP-attached browser belongs to the user (a running desktop app or a
    // manually opened browser). browser.close() on an attached browser only
    // disconnects the transport — the real browser keeps running (verified
    // empirically). The dangerous call is context.close(), which tears down
    // the user's real pages: teardown therefore guards it with ownsBrowser
    // and always calls browser.close() so the node process can exit.
    // closeOnExit === true additionally kills the real browser via raw CDP.
    return {
      browser,
      context,
      ownsBrowser: closeOnExit,
      dispose: closeOnExit ? () => killBrowserOverCdp(job.cdp.endpoint) : undefined,
    }
  },
  electron: async (pw, job) => {
    const { app, context, page } = await launchElectron(pw, job)
    return { app, browser: null, context, page, ownsBrowser: true }
  },
}

async function launchForTarget(pw, job) {
  const target = job.target ?? "web"
  let adapter = TARGETS[target]
  if (!adapter && job.targetAdapter) {
    const mod = await importModule(job.targetAdapter)
    adapter = (mod.default ?? mod)(pw)
    TARGETS[job.target] = adapter
  }
  if (!adapter) throw new Error(`unknown target '${job.target}' (known: ${Object.keys(TARGETS).join(", ")})`)
  emitProgress({ phase: target === "cdp" ? "connect" : "launch", target, channel: job.launch?.channel, endpoint: job.cdp?.endpoint })
  const launched = await adapter(pw, job)
  emitProgress({ phase: target === "cdp" ? "connected" : "launched", target })
  return launched
}

async function main() {
  if (!jobFile) throw new Error("usage: node scenario.mjs <job.json> <out.json>")
  const job = readJson(jobFile)
  job.outputDir = ensureDir(job.outputDir ?? path.dirname(jobFile))
  const policy = mergePolicy(job.policy ?? {})
  const audit = createAuditor(job.auditFile, policy)
  if (job.auditFile) pruneArtifacts(path.dirname(job.auditFile), policy.retention)
  const started = Date.now()
  const result = { ok: true, mode: job.mode ?? "record", target: job.target ?? "web", outputDir: job.outputDir, startedAt: nowIso() }
  if (outFile) writeJson(outFile, result)

  emitProgress({ phase: "start", mode: result.mode, target: result.target, steps: (job.steps ?? []).length, forks: (job.forks ?? []).length })
  assertPolicy(job, policy)
  const navUrls = collectNavUrls(job)
  audit({ event: "run-start", tool: "scenario", mode: result.mode, target: result.target, navigations: navUrls, js: jsFeaturesRequested(job), allowJsProbes: policy.allowJsProbes })

  emitProgress({ phase: "resolve-playwright", projectDir: job.projectDir ?? process.cwd() })
  log(`[gui-doctor] resolving playwright from ${job.projectDir ?? process.cwd()}`)
  const pw = await loadPlaywright(job.projectDir)
  emitProgress({ phase: "playwright-ready" })
  log("[gui-doctor] playwright loaded")

  const runner = async () => {
    const mode = job.mode ?? "record"
    if (mode === "fork") await runFork(pw, job, result)
    else if (mode === "bisect") await runBisect(pw, job, result)
    else await runRecord(pw, job, result)
  }
  await withTimeout(runner(), policy.timeouts?.harness, "harness")

  result.durationMs = Date.now() - started
  result.finishedAt = nowIso()
  const final = finalizeResult(result, policy, audit)
  audit({ event: "run-finish", tool: "scenario", ok: true, durationMs: final.durationMs })
  emitProgress({ phase: "done", mode: result.mode, target: result.target, durationMs: final.durationMs })
  if (outFile) writeJson(outFile, final)
  process.stdout.write(`${JSON.stringify(final)}\n`)
  log(`[gui-doctor] done in ${final.durationMs}ms`)
}

main().catch((err) => {
  try {
    const job = jobFile && fs.existsSync(jobFile) ? readJson(jobFile) : {}
    createAuditor(job.auditFile, mergePolicy(job.policy ?? {}))({ event: "run-error", tool: "scenario", error: err?.message })
  } catch {
    /* ignore */
  }
  fail(outFile, err)
})
process.on("unhandledRejection", (err) => fail(outFile, err))
