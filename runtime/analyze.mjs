import fs from "node:fs"
import path from "node:path"
import { readJson, writeJson } from "./lib/util.mjs"
import { analyzeTrace, formatDigest } from "./lib/trace-analyze.mjs"
import { mergePolicy, isPathAllowed, redactValue } from "./lib/policy.mjs"

const [target, outFile, projectDir] = process.argv.slice(2)

function fail(error) {
  const payload = { ok: false, error: error?.message ?? String(error) }
  if (outFile) writeJson(outFile, payload)
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(1)
}

function resolveTrace(input) {
  if (fs.statSync(input).isFile()) return input
  const diag = path.join(input, "diagnostics.json")
  if (fs.existsSync(diag)) return null
  const trace = path.join(input, "trace.zip")
  if (fs.existsSync(trace)) return trace
  throw new Error(`No trace found in ${input}`)
}

function main() {
  if (!target) throw new Error("usage: node analyze.mjs <trace.zip|run-dir> <out.json> [projectDir]")
  const policy = mergePolicy({})
  const roots = [projectDir, process.cwd()].filter(Boolean)
  if (projectDir && !isPathAllowed(target, roots)) {
    throw new Error(`path '${target}' is outside the sandbox (${roots.join(", ")})`)
  }
  const stat = fs.existsSync(target) ? fs.statSync(target) : null
  if (!stat) throw new Error(`Path not found: ${target}`)

  let source
  let diag
  const diagPath = path.join(target, "diagnostics.json")
  if (stat.isDirectory() && fs.existsSync(diagPath)) {
    source = "diagnostics.json"
    diag = readJson(diagPath)
  } else {
    source = resolveTrace(target)
    diag = analyzeTrace(source)
  }
  if (policy.redaction?.enabled) diag = redactValue(diag, policy)
  const payload = { ok: true, source, digest: formatDigest(diag), diagnostics: diag }
  if (outFile) writeJson(outFile, payload)
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

try {
  main()
} catch (err) {
  fail(err)
}
