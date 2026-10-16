import path from "node:path"
import { readZipText, eachNdjson } from "./zip.mjs"
import { truncate } from "./util.mjs"

function errMessage(error) {
  if (!error) return null
  if (typeof error === "string") return error
  return error.error?.message ?? error.message ?? error.value ?? error.text ?? JSON.stringify(error)
}

function errStack(error) {
  if (!error || typeof error === "string") return null
  return error.error?.stack ?? error.stack ?? null
}

function locationString(loc) {
  if (!loc) return null
  const url = loc.url ?? loc.file ?? ""
  const line = loc.lineNumber ?? loc.line ?? ""
  return `${url}:${line}`.replace(/:$/, "")
}

// Parse a Playwright trace.zip into a structured diagnostic bundle.
// Handles both the single-row `type:"action"` layout and the paired
// `before`/`after` layout used by current Playwright.
export function analyzeTrace(traceFile) {
  // Only inflate the NDJSON streams; screenshots and resource blobs are large
  // and irrelevant to diagnostics.
  const files = readZipText(traceFile, (name) => name.endsWith(".trace") || name.endsWith(".network"))

  const begins = new Map()
  const actions = []
  const errors = []
  const consoleErrors = []
  const consoleWarnings = []
  const pageErrors = []
  const requests = []
  const failedRequests = []
  let requestTotal = 0
  let metadata = null

  const pushAction = (row, begin) => {
    const failed = !!row.error
    actions.push({
      callId: row.callId,
      apiName: row.apiName ?? begin?.apiName,
      class: row.class ?? begin?.class,
      method: row.method ?? begin?.method,
      params: begin?.params ?? row.params,
      startTime: begin?.startTime ?? row.startTime,
      endTime: row.endTime,
      durationMs: begin?.startTime != null && row.endTime != null ? +(row.endTime - begin.startTime).toFixed(1) : null,
      error: errMessage(row.error),
    })
    if (failed) {
      errors.push({ kind: "action", apiName: row.apiName ?? begin?.method, method: row.method ?? begin?.method, message: errMessage(row.error), stack: errStack(row.error) })
    }
  }

  const handleNetworkRow = (row) => {
    const snapshot = row?.snapshot ?? (row?.request ? row : null)
    if (!snapshot) return
    const req = snapshot.request ?? {}
    const res = snapshot.response ?? {}
    if (!req.url) return
    const status = typeof res.status === "number" ? res.status : null
    const entry = {
      method: req.method,
      url: req.url,
      status,
      resourceType: snapshot.resourceType ?? snapshot._resourceType ?? null,
      failure: snapshot.failureText ?? snapshot.failure ?? null,
    }
    requestTotal++
    if (requests.length < 5000) requests.push(entry)
    if ((status != null && status >= 400) || entry.failure) failedRequests.push(entry)
  }

  const handleTraceRow = (row) => {
    if (!row || typeof row !== "object") return
    if (row.snapshot?.request?.url) handleNetworkRow(row)
    switch (row.type) {
      case "context-options":
        metadata = { browserName: row.browserName, options: row.options, origin: row.origin, sdkLanguage: row.sdkLanguage }
        break
      case "before":
        begins.set(row.callId, row)
        break
      case "after":
        pushAction(row, begins.get(row.callId))
        begins.delete(row.callId)
        break
      case "action":
        pushAction(row, row)
        break
      case "error":
        errors.push({ kind: "trace-error", message: errMessage(row.error) ?? row.message ?? "trace error", stack: errStack(row.error) ?? row.stack })
        break
      case "console": {
        const level = row.messageType ?? row.type ?? "log"
        const entry = { level, text: truncate(row.text ?? "", 2000), location: locationString(row.location), time: row.time }
        if (level === "error") consoleErrors.push(entry)
        else if (level === "warning") consoleWarnings.push(entry)
        break
      }
      case "event": {
        if (row.method === "console") {
          const p = row.params ?? {}
          const level = p.type ?? "log"
          const entry = { level, text: truncate(p.text ?? "", 2000), location: locationString(p.location), time: row.time }
          if (level === "error") consoleErrors.push(entry)
          else if (level === "warning") consoleWarnings.push(entry)
        } else if (row.method === "pageError" || row.method === "page-error") {
          const p = row.params ?? {}
          pageErrors.push({ message: errMessage(p.error) ?? p.message ?? String(p), stack: errStack(p.error), location: locationString(p.location), time: row.time })
        }
        break
      }
      default:
        break
    }
  }

  for (const [name, text] of files) {
    if (name.endsWith(".trace")) eachNdjson(text, handleTraceRow)
    else if (name.endsWith(".network")) eachNdjson(text, handleNetworkRow)
  }

  const slowestActions = [...actions]
    .filter((a) => a.durationMs != null)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((a) => ({ apiName: a.apiName, method: a.method, durationMs: a.durationMs, error: a.error }))

  const summary = {
    actionCount: actions.length,
    failedActionCount: errors.filter((e) => e.kind === "action").length,
    errorCount: errors.length,
    consoleErrorCount: consoleErrors.length,
    consoleWarningCount: consoleWarnings.length,
    pageErrorCount: pageErrors.length,
    requestCount: requestTotal,
    failedRequestCount: failedRequests.length,
    hasFailures: errors.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0 || failedRequests.length > 0,
  }

  return {
    traceFile: path.resolve(traceFile),
    files: [...files.keys()],
    metadata,
    summary,
    errors,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    failedRequests,
    slowestActions,
    requests: requests.slice(0, 500),
    timeline: actions.map((a) => ({ apiName: a.apiName, method: a.method, durationMs: a.durationMs, error: a.error })),
  }
}

export function formatDigest(diag) {
  const s = diag.summary
  const lines = []
  lines.push(`Trace: ${diag.traceFile}`)
  lines.push(
    `Actions: ${s.actionCount} (failed ${s.failedActionCount}) | Errors: ${s.errorCount} | Console errors: ${s.consoleErrorCount} | Page errors: ${s.pageErrorCount} | Requests: ${s.requestCount} (failed ${s.failedRequestCount})`
  )
  if (diag.pageErrors.length) {
    lines.push("\nUncaught page errors:")
    for (const e of diag.pageErrors.slice(0, 10)) lines.push(`  - ${truncate(e.message, 600)}`)
  }
  if (diag.consoleErrors.length) {
    lines.push("\nConsole errors:")
    for (const e of diag.consoleErrors.slice(0, 10)) lines.push(`  - [${e.location ?? "?"}] ${truncate(e.text, 600)}`)
  }
  const actionErrors = diag.errors.filter((e) => e.kind === "action")
  if (actionErrors.length) {
    lines.push("\nFailed actions:")
    for (const e of actionErrors.slice(0, 10)) lines.push(`  - ${e.apiName ?? e.method}: ${truncate(e.message, 600)}`)
  }
  if (diag.failedRequests.length) {
    lines.push("\nFailed requests:")
    for (const r of diag.failedRequests.slice(0, 10)) lines.push(`  - ${r.status ?? "ERR"} ${r.method} ${r.url}${r.failure ? ` (${r.failure})` : ""}`)
  }
  if (diag.slowestActions.length) {
    lines.push("\nSlowest actions:")
    for (const a of diag.slowestActions.slice(0, 5)) lines.push(`  - ${a.durationMs}ms ${a.apiName ?? a.method}`)
  }
  return lines.join("\n")
}
