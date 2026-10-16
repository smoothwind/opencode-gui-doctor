import assert from "node:assert"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.join(here, "..", "runtime")
const fixtures = path.join(here, "fixtures")
// Package root (holds playwright-core in node_modules for tests).
const projectDir = path.resolve(here, "..")
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gui-doctor-test-"))

const results = []
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${detail}`}`)
}

function startServer(htmlFile) {
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/dyn")) {
      counter += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ msg: `d${counter}` }))
      return
    }
    if (req.url.startsWith("/api/data")) {
      if (req.url.includes("fail")) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "boom", token: "topsecret" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ msg: "ok-value", items: [1, 2, 3] }))
      return
    }
    if (req.url.startsWith("/bp.js")) {
      res.writeHead(200, { "content-type": "text/javascript" })
      res.end(fs.readFileSync(path.join(path.dirname(htmlFile), "bp.js"), "utf8"))
      return
    }
    if (req.url.startsWith("/bp.html")) {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(fs.readFileSync(path.join(path.dirname(htmlFile), "bp.html"), "utf8"))
      return
    }
    if (req.url.startsWith("/child.html")) {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(fs.readFileSync(path.join(path.dirname(htmlFile), "child.html"), "utf8"))
      return
    }
    if (req.url.startsWith("/app.html") || req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(fs.readFileSync(htmlFile, "utf8"))
      return
    }
    res.writeHead(404).end("not found")
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

function runHarness(script, job) {
  return new Promise((resolve) => {
    const work = fs.mkdtempSync(path.join(outRoot, "run-"))
    const jobPath = path.join(work, "job.json")
    const outPath = path.join(work, "out.json")
    // Container is on by default; these scenarios assert raw (unwrapped)
    // behaviour, so they opt out unless a test sets `container` explicitly.
    fs.writeFileSync(jobPath, JSON.stringify({ container: false, ...job, projectDir }, null, 2))
    const child = spawn(process.execPath, [path.join(runtime, script), jobPath, outPath], { cwd: projectDir })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => {
      const data = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null
      resolve({ code, data, stderr })
    })
  })
}

async function main() {
  const { server, port } = await startServer(path.join(fixtures, "app.html"))
  const url = `http://127.0.0.1:${port}/app.html`
  console.log(`fixture server: ${url}`)

  try {
    // 1. record + trace (JS probes enabled via policy)
    const outDir = path.join(outRoot, "record")
    const rec = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [
        { action: "click", selector: "#load" },
        { action: "click", selector: "#boom" },
        { action: "waitForTimeout", value: "500" },
      ],
      probes: [{ name: "state", expression: "() => window.__STATE__" }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: outDir,
    })
    check("record: harness succeeded", rec.code === 0 && rec.data?.ok, rec.data?.error ?? rec.stderr?.slice(-500))
    check("record: trace.zip produced", rec.data?.traceFile && fs.existsSync(rec.data.traceFile), rec.data?.traceFile ?? "missing")
    const diag = rec.data?.diagnostics
    check("record: page error captured", (diag?.summary?.pageErrorCount ?? 0) >= 1, JSON.stringify(diag?.summary))
    check("record: console error captured", (diag?.summary?.consoleErrorCount ?? 0) >= 1, JSON.stringify(diag?.summary))
    check("record: probe read state", rec.data?.probes?.[0]?.value?.result === "ok-value", JSON.stringify(rec.data?.probes?.[0]))

    // 2. analyze the trace via analyze.mjs
    const analyzed = await new Promise((resolve) => {
      const work = fs.mkdtempSync(path.join(outRoot, "an-"))
      const outPath = path.join(work, "out.json")
      const child = spawn(process.execPath, [path.join(runtime, "analyze.mjs"), rec.data.traceFile, outPath], { cwd: projectDir })
      child.on("close", () => resolve(fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null))
    })
    check("analyze: digest mentions errors", typeof analyzed?.digest === "string" && /Error|error/i.test(analyzed.digest), analyzed?.error ?? "no digest")

    // 3. forked replay probes
    const fork = await runHarness("scenario.mjs", {
      mode: "fork",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [
        { action: "click", selector: "#load" },
        { action: "waitForTimeout", value: "300" },
      ],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      forks: [
        { id: "baseline", forkAt: 2, probes: [{ name: "result", expression: "() => window.__STATE__.result" }] },
        {
          id: "mock500",
          forkAt: 2,
          routeMocks: [{ url: "**/api/data", status: 500, body: { msg: "boom" } }],
          probes: [{ name: "result", expression: "() => window.__STATE__.result" }],
        },
      ],
      outputDir: path.join(outRoot, "fork"),
    })
    check("fork: harness succeeded", fork.code === 0 && fork.data?.ok, fork.data?.error ?? fork.stderr?.slice(-500))
    const baseline = fork.data?.forks?.find((f) => f.id === "baseline")
    const mock = fork.data?.forks?.find((f) => f.id === "mock500")
    check("fork: baseline result ok-value", baseline?.probes?.[0]?.value === "ok-value", JSON.stringify(baseline?.probes?.[0]))
    check("fork: mocked result ERR", mock?.probes?.[0]?.value === "ERR", JSON.stringify(mock?.probes?.[0]))
    const changed = fork.data?.diff?.diffs?.[0]?.changedProbes?.[0]
    check("fork: diff detected probe change", changed?.name === "result" && changed.baseline === "ok-value" && changed.candidate === "ERR", JSON.stringify(fork.data?.diff))

    // 4b. security: JS probes denied by default
    const denied = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "click", selector: "#load" }],
      probes: [{ name: "x", expression: "() => 1" }],
      outputDir: path.join(outRoot, "denied"),
    })
    check("policy: JS probe blocked without allowJsProbes", denied.code !== 0 && /allowJsProbes/.test(denied.data?.error ?? denied.stderr ?? ""), denied.data?.error ?? `exit ${denied.code}`)

    // 4c. security: navigation outside allowlist denied
    const navBlocked = await runHarness("scenario.mjs", {
      mode: "record",
      url: "http://example.com/",
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [],
      outputDir: path.join(outRoot, "nav"),
    })
    check("policy: external navigation blocked", navBlocked.code !== 0 && /allowedOrigins|outside/.test(navBlocked.data?.error ?? navBlocked.stderr ?? ""), navBlocked.data?.error ?? `exit ${navBlocked.code}`)

    // 4d. security: probe output is redacted
    const redacted = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "click", selector: "#load" }],
      probes: [
        {
          name: "secrets",
          expression:
            "() => ({ password: 'hunter2', Authorization: 'Bearer abcdef0123456789abcdef0123456789', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef123456', note: 'keep me' })",
        },
      ],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "redact"),
    })
    const secrets = redacted.data?.probes?.[0]?.value
    const masked = secrets?.password === "[REDACTED]" && secrets?.Authorization === "[REDACTED]" && secrets?.jwt === "[REDACTED]" && secrets?.note === "keep me"
    check("redaction: sensitive fields masked, safe fields kept", masked, JSON.stringify(secrets))

    // 4e. iframe (framePath) interaction
    const iframe = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "click", frame: ["#child"], selector: "#child-btn" }],
      probes: [{ name: "child", expression: "() => document.getElementById('child').contentWindow.__CHILD__" }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "iframe"),
    })
    check("iframe: click inside frame works", iframe.data?.steps?.[0]?.ok === true && iframe.data?.probes?.[0]?.value?.n === 1, JSON.stringify(iframe.data?.steps?.[0]) + JSON.stringify(iframe.data?.probes?.[0]))

    // 4g. container: the target runs wrapped in a visible, labelled iframe
    const contained = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      container: { label: "e2e-container" },
      steps: [{ action: "click", selector: "#load" }],
      probes: [{ name: "state", expression: "() => window.__STATE__" }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "container"),
    })
    check("container: iframe wrapper installed", contained.data?.container?.kind === "iframe" && contained.data?.container?.label === "e2e-container", JSON.stringify(contained.data?.container ?? contained.data?.error))
    check("container: step clicked inside the app frame", contained.data?.steps?.[0]?.ok === true, JSON.stringify(contained.data?.steps?.[0]))
    check("container: probe evaluated in the app frame", contained.data?.probes?.[0]?.value?.result === "ok-value", JSON.stringify(contained.data?.probes?.[0]))
    check("container: screenshot captures the wrapper", fs.existsSync(path.join(outRoot, "container", "final.png")), "final.png missing")

    // 4f. probe preset (storage) + redaction of storage secrets
    const preset = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [],
      probes: [{ name: "store", preset: "storage" }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "preset"),
    })
    const store = preset.data?.probes?.[0]?.value
    check("preset: storage read + secrets redacted", store?.localStorage?.token === "[REDACTED]" && store?.localStorage?.theme === "dark", JSON.stringify(store))

    // --- P2: determinism (HAR), seed, breakpoints, bodies, a11y/visual, bisect ---
    const dynStep = { action: "evaluate", value: 'async () => { const r = await fetch("/api/dyn"); return (await r.json()).msg }' }

    // HAR determinism
    const recHarDir = path.join(outRoot, "rechar")
    const recHar = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [dynStep],
      determinism: { record: true },
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: recHarDir,
    })
    const recordedVal = (recHar.data?.steps ?? []).find((s) => s.action === "evaluate")?.value
    const harPath = path.join(recHarDir, "network.har")
    check("determinism: HAR recorded", fs.existsSync(harPath) && /^d\d+$/.test(String(recordedVal)), `val=${recordedVal} har=${fs.existsSync(harPath)} err=${recHar.data?.error ?? recHar.data?.diagnosticsError ?? ""} steps=${JSON.stringify(recHar.data?.steps)}`)

    const replay = await runHarness("scenario.mjs", {
      mode: "fork",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [dynStep],
      forks: [{ id: "baseline" }],
      determinism: { harPath },
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "forkhar"),
    })
    const replayedVal = (replay.data?.forks?.[0]?.steps ?? []).find((s) => s.action === "evaluate")?.value
    const fresh = await runHarness("scenario.mjs", {
      mode: "fork",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [dynStep],
      forks: [{ id: "baseline" }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "forknohar"),
    })
    const freshVal = (fresh.data?.forks?.[0]?.steps ?? []).find((s) => s.action === "evaluate")?.value
    check("determinism: HAR replay reproduces recorded response", replayedVal === recordedVal && replayedVal !== freshVal, `recorded=${recordedVal} replay=${replayedVal} fresh=${freshVal}`)

    // Seeded randomness
    const seedJob = async (seed, dir) =>
      runHarness("scenario.mjs", {
        mode: "record",
        url,
        target: "web",
        launch: { headless: true, channel: "msedge", timeout: 15000 },
        steps: [],
        probes: [{ name: "rand", expression: "() => window.__RANDOM__" }],
        determinism: { seed },
        policy: { allowJsProbes: true, allowedPaths: [outRoot] },
        outputDir: path.join(outRoot, dir),
      })
    const s1 = await seedJob(42, "seed42a")
    const s2 = await seedJob(42, "seed42b")
    const s3 = await seedJob(7, "seed7")
    check("determinism: same seed �?same Math.random", s1.data?.probes?.[0]?.value === s2.data?.probes?.[0]?.value && s1.data?.probes?.[0]?.value !== s3.data?.probes?.[0]?.value, `${s1.data?.probes?.[0]?.value} ${s2.data?.probes?.[0]?.value} ${s3.data?.probes?.[0]?.value}`)

    // CDP breakpoint probe
    const bp = await runHarness("scenario.mjs", {
      mode: "record",
      url: `http://127.0.0.1:${port}/bp.html`,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "click", selector: "#bp" }],
      breakpointProbes: [{ urlRegex: "bp\\.js", line: 3, expressions: ["n", "doubled"] }],
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "bp"),
    })
    const hit = bp.data?.breakpointProbes?.[0]
    check("breakpoint: paused and read locals", hit?.values?.n === 21 && hit?.values?.doubled === 42, JSON.stringify(bp.data?.breakpointProbes ?? bp.data?.error))

    // Response body capture + redaction
    const bodyRec = await runHarness("scenario.mjs", {
      mode: "record",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "evaluate", value: 'async () => (await fetch("/api/data?fail=1")).status' }],
      capture: { body: true },
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "body"),
    })
    const failed = (bodyRec.data?.events?.requests ?? []).find((r) => r.status === 500 && r.responseBody)
    check("bodies: 500 body captured and redacted", !!failed && /\[REDACTED\]/.test(failed.responseBody) && !/topsecret/.test(failed.responseBody), JSON.stringify(failed))

    // a11y + visual diff on the earlier mock500 fork
    const d0 = fork.data?.diff?.diffs?.[0]
    check("diff: a11y snapshot changed", (d0?.a11yDiff?.changed ?? 0) > 0, JSON.stringify(d0?.a11yDiff))
    check("diff: visual diff produced", !!d0?.visualDiff && !d0.visualDiff.error && d0.visualDiff.changedPixels > 0, JSON.stringify(d0?.visualDiff))

    // auto-bisect
    const bis = await runHarness("scenario.mjs", {
      mode: "bisect",
      url,
      target: "web",
      launch: { headless: true, channel: "msedge", timeout: 15000 },
      steps: [{ action: "click", selector: "#load" }, { action: "click", selector: "#boom" }],
      afterEachProbe: { expression: "() => window.__STATE__.clicks" },
      until: "() => window.__STATE__.clicks > 0",
      policy: { allowJsProbes: true, allowedPaths: [outRoot] },
      outputDir: path.join(outRoot, "bisect"),
    })
    check("bisect: found culprit step", bis.data?.culprit === 2 && bis.data?.iterations?.length === 3, `culprit=${bis.data?.culprit} iters=${bis.data?.iterations?.length}`)

    // 4. env check
    const env = await new Promise((resolve) => {
      const work = fs.mkdtempSync(path.join(outRoot, "env-"))
      const outPath = path.join(work, "out.json")
      const child = spawn(process.execPath, [path.join(runtime, "env-check.mjs"), projectDir, outPath], { cwd: projectDir })
      child.on("close", () => resolve(fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null))
    })
    check("env-check: resolves playwright", !!env?.playwright?.path, JSON.stringify(env?.playwright))
  } finally {
    server.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
