import fs from "node:fs"
import path from "node:path"
import { ensureDir, readJson, writeJson, truncate, nowIso, withTimeout, emitProgress } from "./lib/util.mjs"
import { connectCdp } from "./lib/cdp.mjs"
import { mergePolicy, isUrlAllowed, isEndpointAllowed, redactValue, redactUrl, limitValue, createAuditor, pruneArtifacts } from "./lib/policy.mjs"
import { resolveContainer, cdpBannerExpression } from "./lib/container.mjs"

const [jobFile, outFile] = process.argv.slice(2)
const log = (...a) => process.stderr.write(`${a.join(" ")}\n`)

function fail(error) {
  const payload = { ok: false, error: error?.message ?? String(error), stack: error?.stack, finishedAt: nowIso() }
  if (outFile) writeJson(outFile, payload)
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  log(`[gui-doctor] ERROR ${payload.error}`)
  process.exit(1)
}

function consoleArgsToText(args = []) {
  return args
    .map((a) => (a.value != null ? a.value : a.description ?? a.unserializableValue ?? a.type))
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ")
}

async function evaluate(client, expression) {
  const res = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed")
  }
  return res.result?.value
}

async function collectPerfTrace(client, categories) {
  const chunks = []
  client.on("Tracing.dataCollected", (params) => {
    for (const v of params.value ?? []) chunks.push(v)
  })
  await client.send("Tracing.start", {
    categories: categories?.join(",") ?? "-*,devtools.timeline,blink.user_timing,v8.execute,loading,rail",
    transferMode: "ReturnAsStream",
  })
  return chunks
}

async function finishPerfTrace(client, chunks, file) {
  const completePromise = client.waitFor("Tracing.tracingComplete", { timeoutMs: 30000 })
  await client.send("Tracing.end")
  const complete = await completePromise
  if (complete.stream) {
    let data = ""
    for (;;) {
      const read = await client.send("IO.read", { handle: complete.stream, size: 1 << 20 })
      data += read.data
      if (read.eof) break
    }
    await client.send("IO.close", { handle: complete.stream }).catch(() => {})
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, data, "utf8")
  } else {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify({ traceEvents: chunks }), "utf8")
  }
  return file
}

async function main() {
  if (!jobFile) throw new Error("usage: node cdp-perf.mjs <job.json> <out.json>")
  const job = readJson(jobFile)
  const outDir = ensureDir(job.outputDir ?? path.dirname(jobFile))
  const policy = mergePolicy(job.policy ?? {})
  const audit = createAuditor(job.auditFile, policy)
  if (job.auditFile) pruneArtifacts(path.dirname(job.auditFile), policy.retention)
  const result = { ok: true, mode: "cdp", startedAt: nowIso(), console: [], pageErrors: [], failedRequests: [] }
  if (outFile) writeJson(outFile, result)

  const endpoint = job.cdp?.endpoint ?? "http://127.0.0.1:9222"
  if (!isEndpointAllowed(endpoint, policy)) {
    throw new Error(`CDP endpoint '${endpoint}' is outside cdpAllowedEndpoints [${(policy.cdpAllowedEndpoints ?? []).join(", ")}]`)
  }
  if (job.goto && !isUrlAllowed(job.goto, policy)) {
    throw new Error(`navigation to '${job.goto}' is outside allowedOrigins [${(policy.allowedOrigins ?? []).join(", ")}]`)
  }
  if ((job.probes ?? []).length && !policy.allowJsProbes) {
    throw new Error("CDP probes inject JavaScript; enable allowJsProbes in policy to permit it")
  }
  audit({ event: "run-start", tool: "cdp", endpoint, goto: job.goto, probes: (job.probes ?? []).length, allowJsProbes: policy.allowJsProbes })

  emitProgress({ phase: "connect", target: "cdp", endpoint })
  log(`[gui-doctor] connecting CDP ${endpoint}`)
  const client = await connectCdp(endpoint, { match: job.cdp?.match })
  emitProgress({ phase: "connected", target: "cdp" })

  const container = resolveContainer({ ...job, target: "cdp" })

  try {
    await client.send("Runtime.enable")
    await client.send("Page.enable").catch(() => {})
    await client.send("Log.enable").catch(() => {})
    await client.send("Network.enable").catch(() => {})

    // Register the labelled container banner as a new-document script so it
    // survives reloads / navigations (raw CDP has no Playwright init scripts).
    if (container) {
      try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: cdpBannerExpression(container, job.goto || endpoint) })
      } catch {
        /* best-effort */
      }
    }

    client.on("Runtime.consoleAPICalled", (p) => {
      result.console.push({ level: p.type, text: truncate(consoleArgsToText(p.args), 2000), source: "console-api" })
    })
    client.on("Log.entryAdded", (p) => {
      const e = p.entry ?? {}
      if (e.level === "error" || e.level === "warning") {
        result.console.push({ level: e.level, text: truncate(e.text, 2000), source: "log", url: e.url, lineNumber: e.lineNumber })
      }
    })
    client.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails ?? {}
      result.pageErrors.push({ message: truncate(d.exception?.description ?? d.text, 3000) })
    })
    client.on("Network.loadingFailed", (p) => {
      result.failedRequests.push({ requestId: p.requestId, error: p.errorText, blockedReason: p.blockedReason })
    })
    client.on("Network.responseReceived", (p) => {
      const r = p.response ?? {}
      if (typeof r.status === "number" && r.status >= 400) {
        result.failedRequests.push({ url: r.url, status: r.status, statusText: r.statusText })
      }
    })

    let perfFile = null
    let chunks = []
    if (job.goto) {
      const loaded = client.waitFor("Page.loadEventFired", { timeoutMs: job.navigateTimeout ?? 30000 }).catch(() => null)
      await client.send("Page.navigate", { url: job.goto })
      await loaded
    }

    // Paint the banner into the current document too (the new-document script
    // only fires on the *next* load).
    if (container) {
      emitProgress({ phase: "container", kind: container.kind, target: "cdp", label: container.label })
      try {
        await evaluate(client, cdpBannerExpression(container, job.goto || endpoint))
        result.container = { kind: container.kind, label: container.label, accent: container.accent }
      } catch {
        /* banner is best-effort */
      }
    }

    if (job.perf?.enabled !== false) {
      emitProgress({ phase: "perf", target: "cdp" })
      chunks = await collectPerfTrace(client, job.perf?.categories)
      if (job.perf?.reload && job.goto) {
        await client.send("Page.reload", {}).catch(() => {})
      }
    }

    // let the app run while we observe
    emitProgress({ phase: "observe", target: "cdp", durationMs: job.duration ?? 1500 })
    await new Promise((r) => setTimeout(r, job.duration ?? 1500))

    result.probes = []
    if ((job.probes ?? []).length) emitProgress({ phase: "probes", target: "cdp", count: job.probes.length })
    for (const probe of job.probes ?? []) {
      const started = Date.now()
      try {
        const value = await evaluate(client, probe.expression ?? probe.function)
        result.probes.push({ name: probe.name ?? `probe_${result.probes.length}`, ok: true, value, durationMs: Date.now() - started })
      } catch (err) {
        result.probes.push({ name: probe.name ?? `probe_${result.probes.length}`, ok: false, error: err.message, durationMs: Date.now() - started })
      }
    }

    if (job.perf?.enabled !== false) {
      perfFile = path.join(outDir, job.perf?.fileName ?? "perf-trace.json")
      await finishPerfTrace(client, chunks, perfFile)
      result.perfTraceFile = perfFile
    }
  } finally {
    client.close()
  }

  result.finishedAt = nowIso()
  result.summary = {
    consoleCount: result.console.length,
    consoleErrors: result.console.filter((c) => c.level === "error").length,
    pageErrors: result.pageErrors.length,
    failedRequests: result.failedRequests.length,
  }
  if (policy.redaction?.enabled) {
    result.console = redactValue(result.console, policy)
    result.pageErrors = redactValue(result.pageErrors, policy)
    result.probes = redactValue(result.probes, policy)
    result.failedRequests = result.failedRequests.map((r) => (r.url ? { ...redactValue(r, policy), url: redactUrl(r.url, policy) } : redactValue(r, policy)))
  }
  audit({ event: "run-finish", tool: "cdp", ok: true, summary: result.summary })
  const final = limitValue(result, policy.redaction?.maxTotalBytes)
  emitProgress({ phase: "done", target: "cdp" })
  if (outFile) writeJson(outFile, final)
  process.stdout.write(`${JSON.stringify(final)}\n`)
  log("[gui-doctor] cdp done")
}

main().catch(fail)
process.on("unhandledRejection", fail)
