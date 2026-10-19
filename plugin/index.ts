import { type Plugin, type ToolResult, tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stepSchema, probeSchema, forkSchema, determinismSchema, breakpointProbeSchema, containerSchema, normalizeContainer } from "./schema"

const DEFAULT_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]
const DEFAULT_CDP_ENDPOINTS = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*", "ws://localhost:*", "ws://127.0.0.1:*", "ws://[::1]:*"]

// Kept in sync with runtime/lib/util.mjs `emitProgress`. The harness streams one
// JSON object per stdout line, prefixed with this marker, so we can surface live
// progress without confusing it with the final JSON result or plain logs.
const PROGRESS_MARKER = "@@gui-progress@@"

function parseProgressLine(line: string): any | null {
  const i = line.indexOf(PROGRESS_MARKER)
  if (i < 0) return null
  try {
    return JSON.parse(line.slice(i + PROGRESS_MARKER.length))
  } catch {
    return null
  }
}

// Map a runtime progress event to a live tool title (shown while the tool runs).
function progressTitle(tool: string, p: any): string | null {
  switch (p?.phase) {
    case "start":
      return `${tool} · starting ${p.target ?? ""}`.trim()
    case "resolve-playwright":
      return `${tool} · resolving playwright…`
    case "playwright-ready":
      return `${tool} · playwright ready`
    case "launch":
      return `${tool} · launching ${p.target ?? "browser"}…`
    case "launched":
      return `${tool} · ${p.target ?? "browser"} ready`
    case "container":
      return `${tool} · container (${p.kind ?? "iframe"})${p.label ? ` · ${p.label}` : ""}`
    case "connect":
      return `${tool} · connecting CDP…`
    case "connected":
      return `${tool} · CDP connected`
    case "observe":
      return p.durationMs ? `${tool} · observing ${p.durationMs}ms…` : `${tool} · observing…`
    case "perf":
      return `${tool} · recording perf trace…`
    case "probes":
      return p.count ? `${tool} · running ${p.count} probe(s)…` : `${tool} · running probes…`
    case "step":
      return `${tool} · step ${(p.index ?? 0) + 1}/${p.total ?? "?"} ${p.action ?? ""}${p.ok === false ? " ✗" : ""}`.trim()
    case "fork":
      return `${tool} · fork ${p.id} (${(p.index ?? 0) + 1}/${p.total ?? "?"})`
    case "fork-done":
      return `${tool} · fork ${p.id} ${p.ok === false ? "failed" : "done"}${p.failedSteps ? ` (${p.failedSteps} failed)` : ""}`
    case "run":
      return `${tool} · run ${(p.index ?? 0) + 1}/${p.total ?? "?"}`
    case "bisect":
      return `${tool} · bisect step ${(p.index ?? 0) + 1}/${p.total ?? "?"} ${p.action ?? ""}${p.ok === false ? " ✗" : ""}`.trim()
    case "done":
      return `${tool} · finalizing…`
    default:
      return null
  }
}

// Resolve bundled assets relative to this module so the plugin works both from
// a project's .opencode/plugins and from an installed npm package.
const selfDir: string = (() => {
  const meta = import.meta as any
  if (typeof meta.dir === "string") return meta.dir
  return path.dirname(fileURLToPath(import.meta.url))
})()

function fileUrl(p: string) {
  const abs = path.resolve(p).replace(/\\/g, "/")
  return `file:///${abs.replace(/^\/+/, "")}`
}

type UrlMatcher = (pattern: string, rawUrl: string) => boolean

// Load the runtime's canonical matcher so the plugin's gating and the harness's
// enforcement always agree (single source of truth). Falls back to a local copy
// only if the runtime is somehow missing.
async function loadUrlMatcher(runtimeDir: string): Promise<UrlMatcher> {
  try {
    const mod = await import(pathToFileURL(path.join(runtimeDir, "lib", "urlmatch.mjs")).href)
    if (typeof mod.matchUrlPattern === "function") return mod.matchUrlPattern
  } catch {
    /* fall through to the inline copy */
  }
  return (pattern: string, rawUrl: string) => {
    if (pattern === "*") return true
    try {
      const x = new URL(/:\/\//.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
      const scheme = x.protocol.replace(":", "").toLowerCase()
      const dflt: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443" }
      const target = { scheme, host: x.hostname.toLowerCase(), port: x.port || dflt[scheme] }
      const m = /^(\*|[a-z]+):\/\/(\*|\[[^\]]+\]|[^:/]+)(?::(\*|\d+))?$/i.exec(String(pattern).trim())
      if (!m) return false
      const [, s, host, port] = m
      return (s === "*" || s.toLowerCase() === target.scheme) && (host === "*" || host.toLowerCase() === target.host) && (!port || port === "*" || port === target.port)
    } catch {
      return false
    }
  }
}

function resolveNode(): string {
  if (process.env.GUI_DOCTOR_NODE) return process.env.GUI_DOCTOR_NODE
  // The plugin itself runs on a real runtime binary — reuse it so spawn() never
  // has to resolve a .cmd/.bat shim from PATH (Windows spawn without `shell`
  // refuses to execute those, per CVE-2024-27980). Under Bun, fall back to a
  // bare `node` on PATH (bare names resolve to node.exe, not a shim).
  return process.versions.bun ? "node" : process.execPath
}

type JobScan = {
  jsFeaturesRequested: (job: any) => boolean
  collectNavUrls: (job: any) => string[]
}

// Load the runtime's shared job scanner so the plugin's permission gating and
// the harness's policy enforcement always agree (same pattern as
// loadUrlMatcher). Falls back to a local copy only if the runtime is missing.
async function loadJobScan(runtimeDir: string): Promise<JobScan> {
  try {
    const mod = await import(pathToFileURL(path.join(runtimeDir, "lib", "jobscan.mjs")).href)
    if (typeof mod.jsFeaturesRequested === "function" && typeof mod.collectNavUrls === "function") return mod
  } catch {
    /* fall through to the inline copies */
  }
  const stepsHaveEval = (steps: any[]) => (steps ?? []).some((s) => s?.action === "evaluate" || s?.action === "eval")
  const navActions = ["goto", "navigate", "waitForURL"]
  return {
    jsFeaturesRequested: (job: any) =>
      (job?.probes ?? []).length > 0 ||
      (job?.initScripts ?? []).length > 0 ||
      (job?.routeMocks ?? []).length > 0 ||
      stepsHaveEval(job?.steps) ||
      (job?.breakpointProbes ?? []).length > 0 ||
      !!(job?.afterEachProbe || job?.until) ||
      (job?.forks ?? []).some((f: any) => (f.probes ?? []).length || (f.initScripts ?? []).length || (f.patchAfterLoad ?? []).length || stepsHaveEval(f.steps)),
    collectNavUrls: (job: any) => {
      const urls: string[] = []
      if (job?.url) urls.push(job.url)
      const scan = (steps: any[]) => {
        for (const s of steps ?? []) if (navActions.includes(s?.action)) urls.push(s.value ?? s.url)
      }
      scan(job?.steps)
      for (const f of job?.forks ?? []) scan(f.steps)
      return urls.filter(Boolean)
    },
  }
}

function readJsonSafe(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

// Runtime + skill live next to this module (sibling dirs in the package).
function findRuntimeDir(): string {
  const candidates = [path.join(selfDir, "..", "runtime"), path.join(selfDir, "runtime"), path.join(selfDir, "..", "..", "runtime")]
  for (const c of candidates) if (fs.existsSync(path.join(c, "scenario.mjs"))) return path.resolve(c)
  return path.resolve(path.join(selfDir, "..", "runtime"))
}

function findSkillDir(): string | null {
  const candidates = [path.join(selfDir, "..", "skill"), path.join(selfDir, "..", "..", "..", ".opencode", "skill")]
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c)
  return null
}

export const GuiDoctorPlugin: Plugin = async ({ $, directory, worktree, client }, options) => {
  const projectRoot = directory || worktree || process.cwd()
  const runtimeDir = findRuntimeDir()
  const skillDir = findSkillDir()
  const artifactsDir = path.join(projectRoot, ".gui-doctor")
  const jobsDir = path.join(artifactsDir, "jobs")
  const auditFile = path.join(artifactsDir, "audit.log")
  const opts = (options as any) ?? {}
  const registerMcp = Boolean(opts.registerMcp) || process.env.GUI_DOCTOR_REGISTER_MCP === "1"

  const nodeBin = resolveNode()
  const matchUrlPattern = await loadUrlMatcher(runtimeDir)
  const jobScan = await loadJobScan(runtimeDir)
  const allowedBy = (origins: string[] | undefined, url: string, fallback: string[]) => (origins?.length ? origins : fallback).some((p) => matchUrlPattern(p, url))

  async function toast(variant: "info" | "success" | "warning" | "error", message: string, title = "gui-doctor") {
    try {
      await (client as any)?.tui?.showToast({ body: { message, variant, title, duration: variant === "error" ? 8000 : 4000 } })
    } catch {
      /* toasts are best-effort */
    }
  }

  // Live tool-card updates: the harness streams progress; translate it into the
  // tool title so the user sees phases and per-step status while the run is live.
  function makeProgress(context: any, toolName: string) {
    let last = ""
    return (p: any) => {
      const title = progressTitle(toolName, p)
      if (!title || title === last) return
      last = title
      context.metadata?.({ title, metadata: { live: true, phase: p.phase, progress: p } })
    }
  }

  function partialAttachments(outDir?: string): any[] {
    const attachments: any[] = []
    if (!outDir) return attachments
    const finalPng = path.join(outDir, "final.png")
    if (fs.existsSync(finalPng)) attachments.push({ type: "file", mime: "image/png", url: fileUrl(finalPng), filename: "final.png" })
    const diag = path.join(outDir, "diagnostics.json")
    if (fs.existsSync(diag)) attachments.push({ type: "file", mime: "application/json", url: fileUrl(diag), filename: "diagnostics.json" })
    return attachments
  }

  // Turn a raw harness error into a self-explaining result (title + actionable
  // hints + any partial artifacts) instead of surfacing a bare stack.
  function harnessError(toolName: string, err: any, outDir?: string): ToolResult {
    const msg = (err?.message ?? String(err)).trim()
    const aborted = /aborted by user/i.test(msg)
    const lines = [aborted ? `# ${toolName} aborted` : `# ${toolName} failed`, "", msg]
    const hints: string[] = []
    if (/Could not resolve|MODULE_NOT_FOUND|playwright/i.test(msg)) hints.push("Run `gui_doctor_env`, then install playwright in the project (`npm i -D playwright`) or set `GUI_DOCTOR_PLAYWRIGHT`.")
    if (/executable doesn't exist|browserType\.launch|Failed to launch/i.test(msg)) hints.push('Pass `browser.channel: "msedge"` or `"chrome"`, or run `npx playwright install chromium`.')
    if (/app frame did not load|container:/i.test(msg)) hints.push("The visible container could not wrap the target — check that the URL is reachable, or pass `container: false` to run without it.")
    if (/outside allowedOrigins|outside cdpAllowedEndpoints|allowJsProbes|outside the sandbox/i.test(msg)) hints.push("Blocked by the security policy — approve the permission prompt, or adjust `.gui-doctor.json`.")
    if (/produced no result/i.test(msg)) hints.push("The harness crashed before writing a result; see the stderr above.")
    if (hints.length) lines.push("", "Next steps:", ...hints.map((h) => `- ${h}`))
    return { title: `${toolName} (${aborted ? "aborted" : "error"})`, output: lines.join("\n"), metadata: { error: msg, aborted, outputDir: outDir, redacted: true }, attachments: partialAttachments(outDir) }
  }

  function basePolicyOverrides(): any {
    const overrides: any = {}
    Object.assign(overrides, readJsonSafe(path.join(projectRoot, ".gui-doctor.json")))
    if (opts.policy) Object.assign(overrides, opts.policy)
    if (process.env.GUI_DOCTOR_ALLOW_JS === "1") overrides.allowJsProbes = true
    if (process.env.GUI_DOCTOR_ALLOWED_ORIGINS) overrides.allowedOrigins = process.env.GUI_DOCTOR_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    if (process.env.GUI_DOCTOR_ALLOW_RAW_TRACE === "1") overrides.redaction = { ...(overrides.redaction ?? {}), allowAttachRawTrace: true }
    return overrides
  }

  function ensureArtifactsDir() {
    fs.mkdirSync(jobsDir, { recursive: true })
    const gi = path.join(artifactsDir, ".gitignore")
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n")
  }

  async function runHarness(script: string, job: any, label: string, opts: { onProgress?: (p: any) => void; signal?: AbortSignal } = {}) {
    ensureArtifactsDir()
    const scriptPath = path.join(runtimeDir, script)
    if (!fs.existsSync(scriptPath)) throw new Error(`gui-doctor runtime missing: ${scriptPath}`)
    const id = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const jobPath = path.join(jobsDir, `${id}.json`)
    const outPath = path.join(jobsDir, `${id}.out.json`)
    fs.writeFileSync(jobPath, JSON.stringify({ ...job, projectDir: projectRoot, pluginRoot: runtimeDir, auditFile }, null, 2))

    // Spawn directly (not through the shell) so we can stream the harness's
    // structured progress on stdout line-by-line while still capturing stderr
    // for diagnosis. Progress updates keep the tool card live during the run.
    const child = spawn(nodeBin, [scriptPath, jobPath, outPath], { cwd: projectRoot, env: process.env, windowsHide: true })
    const stderrChunks: string[] = []
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on("line", (line) => {
        const p = parseProgressLine(line)
        if (!p) return
        try {
          opts.onProgress?.(p)
        } catch {
          /* progress is best-effort */
        }
      })
    }
    child.stderr?.on("data", (d) => stderrChunks.push(d.toString()))

    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      const onAbort = () => {
        try {
          if (process.platform === "win32" && child.pid) {
            // child.kill() only terminates the node harness — the Chromium it
            // launched survives as an orphan. /T takes down the whole tree.
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
          } else {
            child.kill()
          }
        } catch {
          /* ignore */
        }
        finish(() => reject(new Error("aborted by user")))
      }
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort()
        opts.signal.addEventListener("abort", onAbort, { once: true })
      }
      child.on("error", (err) => finish(() => reject(err)))
      child.on("close", (code) => finish(() => resolve(code ?? 0)))
    })

    const stderr = stderrChunks.join("")
    if (!fs.existsSync(outPath)) {
      throw new Error(`gui-doctor harness '${script}' produced no result (exit ${exitCode}).\n${stderr.slice(-4000)}`)
    }
    return { data: JSON.parse(fs.readFileSync(outPath, "utf8")), stderr, exitCode, jobPath, outPath }
  }

  async function runPositional(script: string, args: string[], label: string) {
    ensureArtifactsDir()
    const scriptPath = path.join(runtimeDir, script)
    const id = `${label}-${Date.now().toString(36)}`
    const outPath = path.join(jobsDir, `${id}.out.json`)
    const res = await $`${nodeBin} ${scriptPath} ${args} ${outPath}`.cwd(projectRoot).quiet().nothrow()
    if (!fs.existsSync(outPath)) throw new Error(`gui-doctor harness '${script}' produced no result (exit ${res.exitCode}).\n${res.stderr.toString().slice(-4000)}`)
    return { data: JSON.parse(fs.readFileSync(outPath, "utf8")), stderr: res.stderr.toString(), exitCode: res.exitCode, outPath }
  }

  async function gate(context: any, overrides: any, job: any, { endpoint }: { endpoint?: string } = {}): Promise<string[]> {
    const granted: string[] = []
    if (jobScan.jsFeaturesRequested(job) && overrides.allowJsProbes !== true) {
      await context.ask({
        permission: "gui.evaluate",
        patterns: ["<page JavaScript: probes / initScripts / routeMocks / evaluate>"],
        always: ["gui.evaluate"],
        metadata: { reason: "This run injects JavaScript into the page. Approve to allow for this run." },
      })
      overrides.allowJsProbes = true
      granted.push("page JavaScript")
    }
    const outside = jobScan.collectNavUrls(job).filter((u) => !allowedBy(overrides.allowedOrigins, u, DEFAULT_ORIGINS))
    if (outside.length) {
      await context.ask({ permission: "gui.navigate", patterns: outside, always: outside, metadata: { reason: "Navigation targets outside the default localhost allowlist." } })
      overrides.allowedOrigins = [...(overrides.allowedOrigins ?? DEFAULT_ORIGINS), ...outside]
      granted.push(`navigation → ${outside.join(", ")}`)
    }
    if (endpoint && !allowedBy(overrides.cdpAllowedEndpoints, endpoint, DEFAULT_CDP_ENDPOINTS)) {
      await context.ask({ permission: "gui.cdp", patterns: [endpoint], always: [endpoint], metadata: { reason: "Connects to a DevTools endpoint outside the default localhost allowlist." } })
      overrides.cdpAllowedEndpoints = [...(overrides.cdpAllowedEndpoints ?? DEFAULT_CDP_ENDPOINTS), endpoint]
      granted.push(`CDP ${endpoint}`)
    }
    return granted
  }

  function traceAttachments(data: any, allowRaw: boolean, outDir: string): any[] {
    const attachments: any[] = []
    if (allowRaw && data.traceFile && fs.existsSync(data.traceFile)) {
      attachments.push({ type: "file", mime: "application/zip", url: fileUrl(data.traceFile), filename: path.basename(data.traceFile) })
    } else {
      const diag = path.join(outDir, "diagnostics.json")
      if (fs.existsSync(diag)) attachments.push({ type: "file", mime: "application/json", url: fileUrl(diag), filename: "diagnostics.json" })
    }
    const finalPng = path.join(outDir, "final.png")
    if (fs.existsSync(finalPng)) attachments.push({ type: "file", mime: "image/png", url: fileUrl(finalPng), filename: "final.png" })
    return attachments
  }

  const runDir = (name: string) => path.join(artifactsDir, "runs", `${name}-${Date.now().toString(36)}`)

  return {
    tool: {
      gui_doctor_env: tool({
        description: "Check the GUI diagnostics environment: Node, Playwright module resolution, available Chrome/Edge browsers, policy, and how to fix gaps. Run this first.",
        args: {},
        async execute(_args, context) {
          context.metadata?.({ title: "gui_doctor_env · checking environment…", metadata: { live: true, phase: "start" } })
          let data: any
          try {
            data = (await runPositional("env-check.mjs", [projectRoot], "env")).data
          } catch (err) {
            return harnessError("gui_doctor_env", err)
          }
          const p = basePolicyOverrides()
          const lines = [
            "## GUI doctor environment",
            `- Node: ${data.node}`,
            `- Platform: ${data.platform}`,
            `- Playwright: ${data.playwright?.path ? `${data.playwright.name} @ ${data.playwright.path}` : "NOT FOUND"}`,
            `- Browsers: chrome=${data.browsers?.chrome ?? "-"} edge=${data.browsers?.edge ?? "-"}`,
            `- Recommended launch channel: ${data.browsers?.channelSuggestion ?? "(run: npx playwright install chromium)"}`,
            `- Runtime: ${runtimeDir}`,
            `- Skill: ${skillDir ?? "(not registered)"}`,
            `- Security policy: allowJsProbes=${p.allowJsProbes === true ? "on" : "off (asks on demand)"}, raw-trace attach=${p.redaction?.allowAttachRawTrace === true ? "on" : "off"}`,
          ]
          if (data.hints?.length) lines.push("", "Hints:", ...data.hints.map((h: string) => `- ${h}`))
          return { title: "gui_doctor_env", output: lines.join("\n"), metadata: data }
        },
      }),

      gui_trace_record: tool({
        description:
          "Record a scripted GUI scenario with Playwright tracing (DOM snapshots, screenshots, console, network, errors) and return a redacted diagnostic digest. Supports web, CDP-attached browsers, Electron, and iframes (step.frame). Produces trace.zip viewable with `npx playwright show-trace`.",
        args: {
          url: tool.schema.string().optional().describe("Start URL (auto-prepended as a goto step for web targets)"),
          target: tool.schema.enum(["web", "cdp", "electron"]).optional().default("web"),
          steps: tool.schema.array(stepSchema).optional(),
          probes: tool.schema.array(probeSchema).optional().describe("state readers run at the end (require allowJsProbes)"),
          browser: tool.schema
            .object({
              headless: tool.schema.boolean().optional(),
              channel: tool.schema.string().optional().describe("msedge | chrome | chromium"),
              executablePath: tool.schema.string().optional(),
              viewport: tool.schema.object({ width: tool.schema.number(), height: tool.schema.number() }).optional(),
              storageState: tool.schema.string().optional(),
              slowMo: tool.schema.number().optional(),
              timeout: tool.schema.number().optional(),
            })
            .optional(),
          trace: tool.schema.object({ enabled: tool.schema.boolean().optional(), screenshots: tool.schema.boolean().optional(), snapshots: tool.schema.boolean().optional(), sources: tool.schema.boolean().optional(), title: tool.schema.string().optional() }).optional(),
          capture: tool.schema.object({ console: tool.schema.boolean().optional(), network: tool.schema.boolean().optional(), pageErrors: tool.schema.boolean().optional(), screenshotEachStep: tool.schema.boolean().optional(), screenshotOnFailure: tool.schema.boolean().optional().describe("screenshot the page at the first failing step"), video: tool.schema.boolean().optional().describe("record a video of the run (web target)"), body: tool.schema.boolean().optional().describe("capture failed request/response bodies"), bodyAll: tool.schema.boolean().optional().describe("capture bodies for all responses (bounded)") }).optional(),
          determinism: determinismSchema.optional(),
          breakpointProbes: tool.schema.array(breakpointProbeSchema).optional().describe("CDP breakpoint probes (Chromium)"),
          cdp: tool.schema.object({ endpoint: tool.schema.string(), match: tool.schema.string().optional() }).optional(),
          electron: tool.schema.object({ args: tool.schema.array(tool.schema.string()).optional(), executablePath: tool.schema.string().optional() }).optional(),
          container: containerSchema,
          runs: tool.schema.number().optional().describe("repeat the scenario N times (fresh browser each run) to surface flaky steps; report pass/fail per step"),
          runConcurrency: tool.schema.number().optional().describe("run up to N of the repeats in parallel (default 1)"),
          outputDir: tool.schema.string().optional(),
          stopOnFailure: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const overrides = basePolicyOverrides()
          const outDir = args.outputDir ? path.resolve(projectRoot, args.outputDir) : runDir("record")
          const job = { mode: "record", url: args.url, target: args.target ?? "web", steps: args.steps ?? [], probes: args.probes ?? [], launch: args.browser ?? {}, trace: args.trace ?? {}, capture: args.capture ?? {}, determinism: args.determinism, breakpointProbes: args.breakpointProbes, cdp: args.cdp, electron: args.electron, container: normalizeContainer(args.container), runs: args.runs, runConcurrency: args.runConcurrency, outputDir: outDir, stopOnFailure: args.stopOnFailure }
          context.metadata?.({ title: "gui_trace_record · starting…", metadata: { live: true, phase: "start" } })
          const grants = await gate(context, overrides, job, { endpoint: args.cdp?.endpoint })
          if (grants.length) await toast("info", `approved for this run: ${grants.join("; ")}`)
          fs.mkdirSync(outDir, { recursive: true })
          let data: any
          try {
            data = (await runHarness("scenario.mjs", { ...job, policy: overrides }, "record", { onProgress: makeProgress(context, "gui_trace_record"), signal: context.abort })).data
          } catch (err) {
            await toast("error", `gui_trace_record failed: ${(err as any)?.message ?? err}`)
            return harnessError("gui_trace_record", err, outDir)
          }

          const steps = data.steps ?? []
          const failed = steps.filter((s: any) => !s.ok)
          const lines = [`# GUI trace recorded (${data.durationMs}ms)`, `Artifacts: ${outDir}`, `Trace: ${data.traceFile ?? "-"}`]
          if (data.container) lines.push(`Container: ${data.container.kind} (${data.container.label})`)
          lines.push("", `Steps: ${steps.length} (failed ${failed.length})`)
          for (const s of steps) {
            lines.push(`  ${s.ok ? "PASS" : "FAIL"} [${s.index}] ${s.action}${s.error ? ` — ${s.error}` : ""}`)
            if (s.events) {
              for (const e of s.events.pageErrors ?? []) lines.push(`      pageError: ${e}`)
              for (const e of s.events.consoleErrors ?? []) lines.push(`      console: ${e}`)
              for (const e of s.events.failedRequests ?? []) lines.push(`      request: ${e}`)
            }
          }
          if (data.runCount > 1 && data.flake) {
            const f = data.flake
            lines.push("", `Flake: ${f.runs} runs, ${f.failedRuns} failed (${(f.flakeRate * 100).toFixed(0)}%)`)
            if (f.flakySteps.length) for (const s of f.flakySteps) lines.push(`  ~ flaky [${s.index}] ${s.action}: pass ${s.pass}/${f.runs}`)
            else lines.push("  no flaky steps detected")
          }
          if (data.diagnostics?.summary) {
            const d = data.diagnostics.summary
            lines.push("", `Trace: actions=${d.actionCount} errors=${d.errorCount} consoleErrors=${d.consoleErrorCount} pageErrors=${d.pageErrorCount} failedRequests=${d.failedRequestCount}`)
          }
          if (data.events?.pageErrors?.length) lines.push("", "Page errors:", ...data.events.pageErrors.slice(0, 8).map((e: any) => `  - ${e.message}`))
          const consoleErrors = (data.events?.console ?? []).filter((c: any) => c.level === "error")
          if (consoleErrors.length) lines.push("", "Console errors:", ...consoleErrors.slice(0, 8).map((c: any) => `  - ${c.text}`))
          if (data.probes?.length) lines.push("", "Probes:", ...data.probes.map((p: any) => `  - ${p.name}: ${p.ok ? JSON.stringify(p.value) : `ERROR ${p.error}`}`))
          if (data.breakpointProbes?.length) {
            lines.push("", `Breakpoint probes (${data.breakpointProbes.length} hit):`)
            for (const b of data.breakpointProbes.slice(0, 10)) lines.push(`  - ${b.functionName || "<anon>"} @ ${b.url}:${b.line} → ${JSON.stringify(b.values)}`)
          }
          if (data.traceFile) lines.push("", `Open trace: npx playwright show-trace "${data.traceFile}"`)
          if (failed.length) await toast("warning", `gui_trace_record: ${failed.length} failed step(s) — see the result for details`)

          return {
            title: `gui_trace_record (${failed.length ? `${failed.length} failed` : "ok"})`,
            output: lines.join("\n"),
            metadata: { outputDir: outDir, traceFile: data.traceFile, failedSteps: failed.length, diagnostics: data.diagnostics?.summary, redacted: true },
            attachments: traceAttachments(data, overrides.redaction?.allowAttachRawTrace === true, outDir),
          }
        },
      }),

      gui_trace_analyze: tool({
        description: "Analyze a Playwright trace.zip (or a gui-doctor run directory) and return redacted structured diagnostics: failed actions, page errors, console errors, failed requests, slowest actions.",
        args: { path: tool.schema.string().describe("trace.zip file, run directory, or .gui-doctor/... path") },
        async execute(args, context) {
          const target = path.resolve(projectRoot, args.path)
          context.metadata?.({ title: "gui_trace_analyze · parsing trace…", metadata: { live: true, phase: "start" } })
          let data: any
          try {
            data = (await runPositional("analyze.mjs", [target, projectRoot], "analyze")).data
          } catch (err) {
            return harnessError("gui_trace_analyze", err)
          }
          if (!data.ok) return harnessError("gui_trace_analyze", new Error(data.error ?? "analyze failed"))
          return { title: "gui_trace_analyze", output: data.digest ?? "(no digest)", metadata: { source: data.source, summary: data.diagnostics?.summary, redacted: true } }
        },
      }),

      gui_probe_fork: tool({
        description:
          "Forked replay probe (分叉回放探针): replay a scenario to a fork point, then branch into isolated variants (init-scripts, route mocks, patches) and run probes/presets in each. Redacted diff vs the 'baseline' fork. Injects JavaScript (gated by allowJsProbes).",
        args: {
          url: tool.schema.string().optional(),
          target: tool.schema.enum(["web", "cdp", "electron"]).optional().default("web"),
          steps: tool.schema.array(stepSchema).optional(),
          forks: tool.schema.array(forkSchema).describe("Isolated replay variants; include one with id 'baseline'"),
          browser: tool.schema.object({ headless: tool.schema.boolean().optional(), channel: tool.schema.string().optional(), executablePath: tool.schema.string().optional(), viewport: tool.schema.object({ width: tool.schema.number(), height: tool.schema.number() }).optional(), timeout: tool.schema.number().optional() }).optional(),
          trace: tool.schema.object({ enabled: tool.schema.boolean().optional() }).optional(),
          determinism: determinismSchema.optional().describe("HAR/seed/clock for reproducible forks"),
          container: containerSchema,
          forkConcurrency: tool.schema.number().optional().describe("run up to N forks in parallel (each launches its own browser; default 1)"),
          outputDir: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const overrides = basePolicyOverrides()
          const outDir = args.outputDir ? path.resolve(projectRoot, args.outputDir) : runDir("fork")
          const job = { mode: "fork", url: args.url, target: args.target ?? "web", steps: args.steps ?? [], forks: args.forks ?? [], launch: args.browser ?? {}, trace: args.trace ?? {}, determinism: args.determinism, container: normalizeContainer(args.container), forkConcurrency: args.forkConcurrency, outputDir: outDir }
          context.metadata?.({ title: "gui_probe_fork · starting…", metadata: { live: true, phase: "start" } })
          const grants = await gate(context, overrides, job)
          if (grants.length) await toast("info", `approved for this run: ${grants.join("; ")}`)
          fs.mkdirSync(outDir, { recursive: true })
          let data: any
          try {
            data = (await runHarness("scenario.mjs", { ...job, policy: overrides }, "fork", { onProgress: makeProgress(context, "gui_probe_fork"), signal: context.abort })).data
          } catch (err) {
            await toast("error", `gui_probe_fork failed: ${(err as any)?.message ?? err}`)
            return harnessError("gui_probe_fork", err, outDir)
          }

          const lines = ["# Forked replay probe", `Artifacts: ${outDir}`, ""]
          for (const fork of data.forks ?? []) {
            lines.push(`## fork ${fork.id} — ${fork.ok ? "ok" : `ERROR ${fork.error}`}`)
            lines.push(`  forkAt=${fork.forkAt} failedSteps=${fork.failedSteps ?? "?"}`)
            for (const p of fork.probes ?? []) lines.push(`  probe ${p.name}: ${p.ok ? JSON.stringify(p.value) : `ERROR ${p.error}`}`)
            const pageErrs = fork.events?.pageErrors?.length ?? 0
            if (pageErrs) lines.push(`  pageErrors=${pageErrs}`)
          }
          if (data.diff?.diffs?.length) {
            lines.push("", "## Diff vs baseline")
            for (const d of data.diff.diffs) {
              lines.push(`- ${d.forkId}: failedStepΔ=${d.failedStepDelta} pageErrorΔ=${d.pageErrorDelta} consoleΔ=${d.consoleDelta}${d.consoleChanged ? " (console content differs)" : ""}`)
              for (const c of d.changedProbes) lines.push(`    ~ ${c.name}: baseline=${JSON.stringify(c.baseline)} candidate=${JSON.stringify(c.candidate)}`)
              if (d.a11yDiff) lines.push(`    a11y: ${d.a11yDiff.changed} changed lines @ ${d.a11yDiff.atLine}`)
              if (d.visualDiff && !d.visualDiff.error) lines.push(`    visual: ${(d.visualDiff.ratio * 100).toFixed(2)}% pixels differ`)
            }
          }
          if (data.har) lines.push("", `HAR replay: served ${data.har.served}, passed-through ${data.har.passed}`)

          const attachments: any[] = []
          const allowRaw = overrides.redaction?.allowAttachRawTrace === true
          for (const fork of data.forks ?? []) if (allowRaw && fork.traceFile && fs.existsSync(fork.traceFile)) attachments.push({ type: "file", mime: "application/zip", url: fileUrl(fork.traceFile), filename: path.basename(fork.traceFile) })
          for (const d of data.diff?.diffs ?? []) {
            if (d.visualDiff?.diffPath && fs.existsSync(d.visualDiff.diffPath)) attachments.push({ type: "file", mime: "image/png", url: fileUrl(d.visualDiff.diffPath), filename: path.basename(d.visualDiff.diffPath) })
          }
          const badForks = (data.forks ?? []).filter((f: any) => !f.ok)
          if (badForks.length) await toast("warning", `gui_probe_fork: ${badForks.length}/${(data.forks ?? []).length} fork(s) failed — see the result for diffs`)
          return { title: "gui_probe_fork", output: lines.join("\n"), metadata: { outputDir: outDir, redacted: true, forks: (data.forks ?? []).map((f: any) => ({ id: f.id, ok: f.ok, failedSteps: f.failedSteps })) }, attachments }
        },
      }),

      gui_bisect: tool({
        description:
          "Auto-bisect a scenario: replay steps one at a time, evaluate an afterEachProbe after each, and report the first step at which the scenario fails (or a custom `until` predicate becomes truthy). Optionally deterministic (HAR/seed/clock). Injects JavaScript (gated).",
        args: {
          url: tool.schema.string().optional(),
          target: tool.schema.enum(["web", "cdp", "electron"]).optional().default("web"),
          steps: tool.schema.array(stepSchema).describe("Ordered steps to replay"),
          afterEachProbe: probeSchema.optional().describe("state read after every step (expression or preset)"),
          until: tool.schema.string().optional().describe('stop when this expression is truthy, e.g. "() => !!document.querySelector(\'.error\')"'),
          browser: tool.schema.object({ headless: tool.schema.boolean().optional(), channel: tool.schema.string().optional(), executablePath: tool.schema.string().optional(), viewport: tool.schema.object({ width: tool.schema.number(), height: tool.schema.number() }).optional(), timeout: tool.schema.number().optional() }).optional(),
          determinism: determinismSchema.optional(),
          container: containerSchema,
          outputDir: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const overrides = basePolicyOverrides()
          const outDir = args.outputDir ? path.resolve(projectRoot, args.outputDir) : runDir("bisect")
          const job = { mode: "bisect", url: args.url, target: args.target ?? "web", steps: args.steps ?? [], afterEachProbe: args.afterEachProbe, until: args.until, launch: args.browser ?? {}, determinism: args.determinism, container: normalizeContainer(args.container), outputDir: outDir }
          context.metadata?.({ title: "gui_bisect · starting…", metadata: { live: true, phase: "start" } })
          const grants = await gate(context, overrides, job)
          if (grants.length) await toast("info", `approved for this run: ${grants.join("; ")}`)
          fs.mkdirSync(outDir, { recursive: true })
          let data: any
          try {
            data = (await runHarness("scenario.mjs", { ...job, policy: overrides }, "bisect", { onProgress: makeProgress(context, "gui_bisect"), signal: context.abort })).data
          } catch (err) {
            await toast("error", `gui_bisect failed: ${(err as any)?.message ?? err}`)
            return harnessError("gui_bisect", err, outDir)
          }

          const lines = [`# Step bisect`, `Artifacts: ${outDir}`, ""]
          for (const it of data.iterations ?? []) {
            lines.push(`  ${it.matched ? ">>" : "  "} [${it.index}] ${it.action} stepOk=${it.stepOk}${it.probe !== undefined && it.probe !== null ? ` probe=${JSON.stringify(it.probe)}` : ""}${it.stepError ? ` err=${it.stepError}` : ""}`)
          }
          lines.push("", data.culprit != null ? `First divergence at step #${data.culprit} (${data.culpritStep?.action}).` : "No failing step detected.")
          if (data.culprit != null) await toast("warning", `gui_bisect: first divergence at step #${data.culprit} (${data.culpritStep?.action})`)
          return { title: `gui_bisect (${data.culprit != null ? `culprit #${data.culprit}` : "clean"})`, output: lines.join("\n"), metadata: { outputDir: outDir, culprit: data.culprit, redacted: true } }
        },
      }),

      gui_cdp_inspect: tool({
        description:
          "Attach to a running Chrome/Chromium/Electron over the Chrome DevTools Protocol (as used by chrome-devtools-mcp). Collects redacted console, exceptions and failed requests, runs probes (gated), and optionally records a DevTools performance trace.",
        args: {
          endpoint: tool.schema.string().optional().describe("http://127.0.0.1:9222 or a ws:// debugger url"),
          match: tool.schema.string().optional(),
          goto: tool.schema.string().optional(),
          duration: tool.schema.number().optional().describe("observation window in ms (default 1500)"),
          probes: tool.schema.array(probeSchema).optional(),
          perf: tool.schema.object({ enabled: tool.schema.boolean().optional(), reload: tool.schema.boolean().optional(), categories: tool.schema.array(tool.schema.string()).optional() }).optional(),
          container: containerSchema,
          closeOnExit: tool.schema.boolean().optional().describe("kill the attached browser on exit (default false — it belongs to the user)"),
          outputDir: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const overrides = basePolicyOverrides()
          const endpoint = args.endpoint ?? "http://127.0.0.1:9222"
          const outDir = args.outputDir ? path.resolve(projectRoot, args.outputDir) : runDir("cdp")
          const job = { cdp: { endpoint, match: args.match, closeOnExit: args.closeOnExit === true }, goto: args.goto, duration: args.duration ?? 1500, probes: args.probes ?? [], perf: args.perf ?? {}, container: normalizeContainer(args.container), outputDir: outDir }
          context.metadata?.({ title: "gui_cdp_inspect · connecting…", metadata: { live: true, phase: "start" } })
          // Include goto as a navigation target so out-of-allowlist URLs get a
          // permission prompt instead of a hard harness-side rejection.
          const grants = await gate(context, overrides, { probes: job.probes, url: args.goto }, { endpoint })
          if (grants.length) await toast("info", `approved for this run: ${grants.join("; ")}`)
          fs.mkdirSync(outDir, { recursive: true })
          let data: any
          try {
            data = (await runHarness("cdp-perf.mjs", { ...job, policy: overrides }, "cdp", { onProgress: makeProgress(context, "gui_cdp_inspect"), signal: context.abort })).data
          } catch (err) {
            await toast("error", `gui_cdp_inspect failed: ${(err as any)?.message ?? err}`)
            return harnessError("gui_cdp_inspect", err, outDir)
          }

          const lines = ["# CDP inspection", `Summary: consoleErrors=${data.summary?.consoleErrors ?? 0} pageErrors=${data.summary?.pageErrors ?? 0} failedRequests=${data.summary?.failedRequests ?? 0}`]
          for (const p of data.probes ?? []) lines.push(`  probe ${p.name}: ${p.ok ? JSON.stringify(p.value) : `ERROR ${p.error}`}`)
          if (data.pageErrors?.length) lines.push("", "Exceptions:", ...data.pageErrors.slice(0, 8).map((e: any) => `  - ${e.message}`))
          const errors = (data.console ?? []).filter((c: any) => c.level === "error")
          if (errors.length) lines.push("", "Console errors:", ...errors.slice(0, 8).map((c: any) => `  - ${c.text}`))

          const attachments: any[] = []
          if (data.perfTraceFile && fs.existsSync(data.perfTraceFile)) attachments.push({ type: "file", mime: "application/json", url: fileUrl(data.perfTraceFile), filename: "perf-trace.json" })
          const issues = (data.summary?.consoleErrors ?? 0) + (data.summary?.pageErrors ?? 0) + (data.summary?.failedRequests ?? 0)
          if (issues) await toast("warning", `gui_cdp_inspect: ${issues} issue(s) detected — see the result for details`)
          return { title: "gui_cdp_inspect", output: lines.join("\n"), metadata: { outputDir: outDir, summary: data.summary, perfTraceFile: data.perfTraceFile, redacted: true }, attachments }
        },
      }),
    },

    // Consistent artifact footer + open-trace hint for every gui_* result, so
    // outputs read the same way regardless of which tool produced them.
    async "tool.execute.after"(input: { tool: string }, output: any) {
      if (!input?.tool?.startsWith("gui_") || !output) return
      const meta = output.metadata ?? {}
      const out = String(output.output ?? "")
      if (meta.outputDir && !/Artifacts:|Run dir:/.test(out)) {
        const rel = path.relative(projectRoot, meta.outputDir).replace(/\\/g, "/") || meta.outputDir
        output.output = `${out}\n\nArtifacts: ${rel}`
      }
      if (meta.traceFile) output.metadata = { ...meta, openTrace: `npx playwright show-trace "${meta.traceFile}"` }
    },

    async config(input: any) {
      // Make the bundled skill discoverable for this project.
      if (skillDir) {
        input.skills = input.skills ?? {}
        const paths: string[] = Array.isArray(input.skills.paths) ? input.skills.paths : []
        if (!paths.includes(skillDir)) input.skills.paths = [...paths, skillDir]
      }
      if (!registerMcp) return
      input.mcp = input.mcp ?? {}
      if (!input.mcp.playwright) input.mcp.playwright = { type: "local", command: ["npx", "-y", "@playwright/mcp@latest"], enabled: true }
      if (!input.mcp["chrome-devtools"]) input.mcp["chrome-devtools"] = { type: "local", command: ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated", "--no-usage-statistics"], enabled: true }
    },

    async "shell.env"(_input: any, output: any) {
      output.env.GUI_DOCTOR_HOME = artifactsDir
      output.env.GUI_DOCTOR_RUNTIME = runtimeDir
    },
  }
}
