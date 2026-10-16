#!/usr/bin/env node
// gui-doctor CLI — a thin wrapper over the runtime harnesses so you don't have
// to hand-author job JSON. It injects the fields the plugin normally supplies
// (projectDir / pluginRoot / auditFile / outputDir) and prints a readable
// digest.
//
//   gui-doctor env        [--project <dir>] [--json]
//   gui-doctor analyze    <trace.zip|run-dir> [--project <dir>]
//   gui-doctor record     --url <url> [--target web|cdp|electron] [--endpoint <cdp>]
//                         [--steps <file|json>] [--probe <expr>]... [--init-script <file>]...
//                         [--channel msedge] [--headless] [--no-headless] [--trace]
//                         [--network] [--no-screenshots] [--allow-js] [--out <dir>]
//                         [--project <dir>] [--json]
//   gui-doctor cdp        [--endpoint <cdp>] [--match <substr>] [--goto <url>]
//                         [--duration <ms>] [--probe <expr>]... [--perf] [--out <dir>]
//   gui-doctor run        <job.json> [--project <dir>]   # any mode (record|fork|bisect)
//
// The runtime scripts live next to this file; Playwright is resolved from the
// project, then cwd, then this package.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const runtimeDir = path.dirname(fileURLToPath(import.meta.url))

const HELP = `gui-doctor — GUI error diagnosis harness (Playwright / CDP)

Usage:
  gui-doctor env     [--project <dir>] [--json]
  gui-doctor analyze <trace.zip|run-dir> [--project <dir>]
  gui-doctor record  --url <url> [options]
  gui-doctor fork    --url <url> --forks <file|json> [options]
  gui-doctor bisect  --url <url> --steps <file|json> [options]
  gui-doctor cdp     [--endpoint http://127.0.0.1:9222] [options]
  gui-doctor run     <job.json> [--project <dir>]

Common options:
  --project <dir>       Project root (sandbox root; default: cwd)
  --out <dir>           Output dir (must live inside --project)
  --json                Print the full JSON result instead of a digest
  --allow-js            Permit page JavaScript (probes / init scripts / evaluate)
  --har <path>          Replay network from a recorded HAR (fork/bisect; record writes one with --record-har)
  --seed <n>            Seed Math.random (mulberry32)
  --clock <iso|ms>      Freeze the page clock
  --container-label <s> Label shown by the visible container (default: gui-doctor)
  --no-container        Disable the visible container (default: on)

record options:
  --target web|cdp|electron   Default: cdp when --endpoint is given, else web
  --url <url>           Start URL (web). For cdp the page is already open
  --endpoint <cdp>      CDP endpoint, e.g. http://127.0.0.1:9222
  --match <substr>      Pick the CDP page/context whose URL contains this substring
  --steps <file|json>   Step array: a path to JSON, or inline JSON
  --probe <expr>        Page probe expression or preset name (repeatable)
  --init-script <file>  JS injected before page scripts (repeatable)
  --channel <name>      Browser channel for web target (msedge | chrome | chromium)
  --headless            Run web headless (default: true); --no-headless to show
  --trace               Record a Playwright trace (web target)
  --record-har          Record network to network.har (web target)
  --network             Capture network failures
  --bodies-all          Capture response bodies for all responses (not just failures)
  --no-screenshots      Skip a screenshot per step
  --screenshot-on-failure  Screenshot the page at the first failing step
  --video               Record a video of the run (web target)
  --runs <n>            Repeat N times (fresh browser each) and report flaky steps
  --run-concurrency <n> Run up to N of the repeats in parallel (default 1)
  --stop-on-failure     Abort at the first failing step (default: true); --no-stop-on-failure

fork/bisect options (target selection):
  --target web|cdp|electron   Default: cdp when --endpoint is given, else web
  --endpoint/--match       Same meaning as in record

fork options:
  --forks <file|json>   Fork array (id/forkAt/routeMocks/probes/initScripts/patchAfterLoad/steps); include id 'baseline'
  --fork-concurrency <n>  Run up to N forks in parallel (default 1)

bisect options:
  --after-each-probe <expr>  Probe evaluated after every step
  --until <expr>        Stop when this expression is truthy (default: first step failure)

cdp options:
  --endpoint <cdp>      CDP endpoint (default http://127.0.0.1:9222)
  --goto <url>          Navigate the attached page first
  --duration <ms>       Observation window (default 1500)
  --perf                Record a DevTools performance trace
  --close-on-exit       Kill the attached browser on exit (default: leave it running)

Examples:
  gui-doctor env
  gui-doctor record --url http://localhost:1420 --channel msedge --steps steps.json
  gui-doctor record --url http://localhost:1420 --runs 5 --steps steps.json --json
  gui-doctor fork --url http://localhost:1420 --steps steps.json --forks forks.json
  gui-doctor bisect --url http://localhost:1420 --steps steps.json --until "() => !!document.querySelector('.error')"
  gui-doctor cdp --endpoint http://127.0.0.1:9222 --duration 3000
  gui-doctor run .gui-doctor/jobs/record-abc.json
`

function parse(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      let key = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      let val = eq >= 0 ? a.slice(eq + 1) : undefined
      if (val === undefined) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          val = next
          i++
        } else {
          val = true
        }
      }
      key = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      flags[key] = flags[key] === undefined ? val : [].concat(flags[key], val)
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

const bool = (v, dflt = false) => (v === undefined ? dflt : v === true || v === "true" || v === "1")

function fail(msg) {
  process.stderr.write(`gui-doctor: ${msg}\n`)
  process.exit(1)
}

const ts = () => Date.now().toString(36)

function ensureArtifacts(projectDir) {
  const dir = path.join(projectDir, ".gui-doctor")
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true })
  const gi = path.join(dir, ".gitignore")
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n")
  return dir
}

function runScript(script, args, outFile) {
  const scriptPath = path.join(runtimeDir, script)
  if (!fs.existsSync(scriptPath)) fail(`runtime missing: ${scriptPath}`)
  const res = spawnSync(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" })
  let data = null
  if (outFile && fs.existsSync(outFile)) {
    try {
      data = JSON.parse(fs.readFileSync(outFile, "utf8"))
    } catch {
      /* ignore */
    }
  }
  if (res.status !== 0 && !data) fail(`'${script}' exited with code ${res.status}`)
  return { data, stdout: res.stdout ?? "" }
}

function runJob(script, job, artifacts, label) {
  const id = `${label}-${ts()}-${Math.random().toString(36).slice(2, 6)}`
  const jobPath = path.join(artifacts, "jobs", `${id}.json`)
  const outPath = path.join(artifacts, "jobs", `${id}.out.json`)
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2))
  const { data } = runScript(script, [jobPath, outPath], outPath)
  return { data, jobPath, outPath }
}

function asList(v) {
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

function stepsFrom(flags) {
  const s = flags.steps
  if (!s) return []
  const str = String(s).trim()
  const text = str.startsWith("[") ? str : fs.readFileSync(path.resolve(str), "utf8")
  const arr = JSON.parse(text)
  if (!Array.isArray(arr)) throw new Error("--steps must be a JSON array")
  return arr
}

function jsonFrom(flags, key, label) {
  const v = flags[key]
  if (!v) return undefined
  const str = String(v).trim()
  const text = str.startsWith("[") || str.startsWith("{") ? str : fs.readFileSync(path.resolve(str), "utf8")
  return JSON.parse(text)
}

function probesFrom(flags) {
  return asList(flags.probe).map((expression, i) => ({
    name: `probe_${i}`,
    expression: String(expression),
  }))
}

function initScriptsFrom(flags) {
  return asList(flags.initScript).map((f) => path.resolve(String(f)))
}

function stepsHaveEval(steps) {
  return steps.some((s) => s?.action === "evaluate" || s?.action === "eval")
}

function policyFrom(flags, { probes = [], initScripts = [], steps = [] } = {}) {
  const p = {}
  const needsJs =
    bool(flags.allowJs, false) ||
    probes.length > 0 ||
    initScripts.length > 0 ||
    stepsHaveEval(steps) ||
    flags.afterEachProbe !== undefined ||
    flags.until !== undefined
  if (needsJs) p.allowJsProbes = true
  if (flags.allowedOrigins) p.allowedOrigins = String(flags.allowedOrigins).split(",").map((s) => s.trim()).filter(Boolean)
  if (flags.cdpEndpoints) p.cdpAllowedEndpoints = String(flags.cdpEndpoints).split(",").map((s) => s.trim()).filter(Boolean)
  if (bool(flags.allowRawTrace, false)) p.redaction = { allowAttachRawTrace: true }
  return p
}

function containerFrom(flags) {
  if (bool(flags.noContainer, false)) return false
  if (flags.containerLabel || flags.containerAccent) return { label: flags.containerLabel ? String(flags.containerLabel) : undefined, accent: flags.containerAccent ? String(flags.containerAccent) : undefined }
  return undefined
}

function determinismFrom(flags) {
  const d = {}
  if (bool(flags.recordHar, false)) d.record = true
  if (flags.har) d.harPath = path.resolve(String(flags.har))
  if (flags.seed !== undefined && flags.seed !== true) d.seed = Number(flags.seed)
  if (flags.clock) d.clockTime = String(flags.clock)
  return Object.keys(d).length ? d : undefined
}

function formatEnv(data) {
  if (!data) return "(no env report)\n"
  const lines = [
    "## gui-doctor environment",
    `- Node: ${data.node}`,
    `- Platform: ${data.platform}`,
    `- Playwright: ${data.playwright?.path ? `${data.playwright.name} @ ${data.playwright.path}` : "NOT FOUND"}`,
    `- Browsers: chrome=${data.browsers?.chrome ?? "-"} edge=${data.browsers?.edge ?? "-"}`,
  ]
  for (const h of data.hints ?? []) lines.push(`  hint: ${h}`)
  return lines.join("\n") + "\n"
}

function report(data, outPath) {
  if (!data) {
    process.stdout.write("(no result)\n")
    return
  }
  const lines = [`ok=${data.ok} mode=${data.mode ?? "-"} target=${data.target ?? "-"}`]
  if (data.outputDir) lines.push(`outputDir: ${data.outputDir}`)
  if (data.traceFile) lines.push(`trace: ${data.traceFile}`)
  for (const s of data.steps ?? []) lines.push(`  ${s.ok ? "PASS" : "FAIL"} [${s.index}] ${s.action}${s.error ? ` — ${s.error}` : ""}`)
  const summary = data.diagnostics?.summary ?? data.summary
  if (summary) lines.push(`summary: ${JSON.stringify(summary)}`)
  if (data.flake) {
    const f = data.flake
    lines.push(`flake: ${f.runs} runs, ${f.failedRuns} failed (${(f.flakeRate * 100).toFixed(0)}%), ${f.flakySteps.length} flaky step(s)`)
    for (const s of f.flakySteps) lines.push(`  ~ flaky [${s.index}] ${s.action}: pass ${s.pass}/${f.runs}`)
  }
  if (data.mode === "fork") {
    for (const fork of data.forks ?? []) {
      lines.push(`fork ${fork.id}: ${fork.ok ? "ok" : `ERROR ${fork.error}`} failedSteps=${fork.failedSteps ?? "?"}`)
      for (const p of fork.probes ?? []) lines.push(`  probe ${p.name}: ${p.ok ? JSON.stringify(p.value) : `ERROR ${p.error}`}`)
    }
    const d0 = data.diff?.diffs ?? []
    for (const d of d0) lines.push(`diff ${d.forkId}: failedStepΔ=${d.failedStepDelta} changedProbes=${(d.changedProbes ?? []).length}`)
  }
  if (data.mode === "bisect") {
    lines.push(data.culprit != null ? `culprit: step #${data.culprit} (${data.culpritStep?.action})` : "no failing step detected")
  }
  for (const e of data.events?.pageErrors ?? data.pageErrors ?? []) lines.push(`  pageError: ${String(e.message).split("\n")[0]}`)
  const consoleErrors = [...(data.events?.console ?? []), ...(data.console ?? [])].filter((c) => c.level === "error" || c.level === "warning")
  for (const c of consoleErrors.slice(0, 15)) lines.push(`  ${c.level}: ${String(c.text).split("\n")[0]}`)
  for (const p of data.probes ?? []) lines.push(`  probe ${p.name}: ${p.ok ? JSON.stringify(p.value) : `ERROR ${p.error}`}`)
  if (outPath) lines.push(`out: ${outPath}`)
  process.stdout.write(lines.join("\n") + "\n")
}

function output(data, flags, outPath) {
  if (bool(flags.json, false)) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n")
    return
  }
  report(data, outPath)
}

function main() {
  const { flags, positional } = parse(process.argv.slice(2))
  const cmd = positional[0]
  if (!cmd || cmd === "help" || bool(flags.help, false)) {
    process.stdout.write(HELP)
    return
  }

  const projectDir = path.resolve(flags.project ? String(flags.project) : process.cwd())
  const artifacts = ensureArtifacts(projectDir)
  const auditFile = path.join(artifacts, "audit.log")
  const defaultOut = (name) => path.join(artifacts, "runs", `${name}-${ts()}`)

  if (cmd === "env") {
    const out = path.join(artifacts, "jobs", `env-${ts()}.out.json`)
    const { data } = runScript("env-check.mjs", [projectDir, out], out)
    process.stdout.write(bool(flags.json, false) ? JSON.stringify(data, null, 2) + "\n" : formatEnv(data))
    return
  }

  if (cmd === "analyze") {
    const target = positional[1]
    if (!target) fail("usage: gui-doctor analyze <trace.zip|run-dir>")
    const out = path.join(artifacts, "jobs", `analyze-${ts()}.out.json`)
    const { data } = runScript("analyze.mjs", [path.resolve(target), out, projectDir], out)
    process.stdout.write(data?.digest ?? JSON.stringify(data) + "\n")
    return
  }

  if (cmd === "cdp") {
    const outDir = flags.out ? path.resolve(String(flags.out)) : defaultOut("cdp")
    const probes = probesFrom(flags)
    const job = {
      cdp: { endpoint: flags.endpoint ? String(flags.endpoint) : "http://127.0.0.1:9222", match: flags.match, closeOnExit: bool(flags.closeOnExit, false) },
      goto: flags.goto,
      duration: Number(flags.duration ?? 1500),
      probes,
      perf: bool(flags.perf, false) ? { enabled: true } : {},
      outputDir: outDir,
      projectDir,
      pluginRoot: runtimeDir,
      auditFile,
      policy: policyFrom(flags, { probes }),
    }
    const container = containerFrom(flags)
    if (container !== undefined) job.container = container
    const { data, outPath } = runJob("cdp-perf.mjs", job, artifacts, "cdp")
    output(data, flags, outPath)
    return
  }

  if (cmd === "record") {
    const steps = stepsFrom(flags)
    const probes = probesFrom(flags)
    const initScripts = initScriptsFrom(flags)
    const target = flags.target ? String(flags.target) : flags.endpoint ? "cdp" : "web"
    const outDir = flags.out ? path.resolve(String(flags.out)) : defaultOut("record")
    const job = {
      mode: "record",
      url: flags.url,
      target,
      steps,
      probes,
      initScripts,
      cdp: target === "cdp" || flags.endpoint ? { endpoint: flags.endpoint ? String(flags.endpoint) : "http://127.0.0.1:9222", match: flags.match } : undefined,
      launch: { headless: bool(flags.headless, true), channel: flags.channel },
      trace: { enabled: bool(flags.trace, false) },
      capture: {
        console: true,
        pageErrors: true,
        network: bool(flags.network, false),
        screenshotEachStep: bool(flags.screenshots, true),
        screenshotOnFailure: bool(flags.screenshotOnFailure, false),
        video: bool(flags.video, false),
        bodyAll: bool(flags.bodiesAll, false),
      },
      determinism: determinismFrom(flags),
      runs: flags.runs !== undefined && flags.runs !== true ? Number(flags.runs) : undefined,
      runConcurrency: flags.runConcurrency !== undefined && flags.runConcurrency !== true ? Number(flags.runConcurrency) : undefined,
      stopOnFailure: flags.stopOnFailure === undefined ? undefined : bool(flags.stopOnFailure),
      outputDir: outDir,
      projectDir,
      pluginRoot: runtimeDir,
      auditFile,
      policy: policyFrom(flags, { probes, initScripts, steps }),
    }
    const container = containerFrom(flags)
    if (container !== undefined) job.container = container
    const { data, outPath } = runJob("scenario.mjs", job, artifacts, "record")
    output(data, flags, outPath)
    return
  }

  if (cmd === "fork") {
    const steps = stepsFrom(flags)
    const forks = jsonFrom(flags, "forks", "--forks")
    if (!Array.isArray(forks) || forks.length === 0) fail("--forks must be a non-empty JSON array")
    const target = flags.target ? String(flags.target) : flags.endpoint ? "cdp" : "web"
    const outDir = flags.out ? path.resolve(String(flags.out)) : defaultOut("fork")
    const job = {
      mode: "fork",
      url: flags.url,
      target,
      steps,
      forks,
      cdp: target === "cdp" || flags.endpoint ? { endpoint: flags.endpoint ? String(flags.endpoint) : "http://127.0.0.1:9222", match: flags.match } : undefined,
      launch: { headless: bool(flags.headless, true), channel: flags.channel },
      trace: { enabled: bool(flags.trace, false) },
      determinism: determinismFrom(flags),
      forkConcurrency: flags.forkConcurrency !== undefined && flags.forkConcurrency !== true ? Number(flags.forkConcurrency) : undefined,
      outputDir: outDir,
      projectDir,
      pluginRoot: runtimeDir,
      auditFile,
      policy: policyFrom(flags, { steps }),
    }
    const container = containerFrom(flags)
    if (container !== undefined) job.container = container
    const { data, outPath } = runJob("scenario.mjs", job, artifacts, "fork")
    output(data, flags, outPath)
    return
  }

  if (cmd === "bisect") {
    const steps = stepsFrom(flags)
    const target = flags.target ? String(flags.target) : flags.endpoint ? "cdp" : "web"
    const outDir = flags.out ? path.resolve(String(flags.out)) : defaultOut("bisect")
    const job = {
      mode: "bisect",
      url: flags.url,
      target,
      steps,
      afterEachProbe: flags.afterEachProbe ? { expression: String(flags.afterEachProbe) } : undefined,
      until: flags.until ? String(flags.until) : undefined,
      cdp: target === "cdp" || flags.endpoint ? { endpoint: flags.endpoint ? String(flags.endpoint) : "http://127.0.0.1:9222", match: flags.match } : undefined,
      launch: { headless: bool(flags.headless, true), channel: flags.channel },
      determinism: determinismFrom(flags),
      outputDir: outDir,
      projectDir,
      pluginRoot: runtimeDir,
      auditFile,
      policy: policyFrom(flags, { steps }),
    }
    const container = containerFrom(flags)
    if (container !== undefined) job.container = container
    const { data, outPath } = runJob("scenario.mjs", job, artifacts, "bisect")
    output(data, flags, outPath)
    return
  }

  if (cmd === "run") {
    const jobFile = positional[1]
    if (!jobFile) fail("usage: gui-doctor run <job.json>")
    const job = JSON.parse(fs.readFileSync(path.resolve(jobFile), "utf8"))
    job.projectDir = job.projectDir ?? projectDir
    job.pluginRoot = job.pluginRoot ?? runtimeDir
    job.auditFile = job.auditFile ?? auditFile
    job.outputDir = job.outputDir ?? defaultOut(job.mode ?? "record")
    job.policy = { ...(job.policy ?? {}), ...policyFrom(flags, { probes: job.probes ?? [], initScripts: job.initScripts ?? [], steps: job.steps ?? [] }) }
    const container = containerFrom(flags)
    if (container !== undefined) job.container = container
    const { data, outPath } = runJob("scenario.mjs", job, artifacts, job.mode ?? "record")
    output(data, flags, outPath)
    return
  }

  fail(`unknown command '${cmd}' — run 'gui-doctor --help'`)
}

main()
