// Security policy: origin/endpoint allowlists, filesystem sandbox, centralized
// redaction, output size caps and an audit trail. Enforced inside every harness
// (defense in depth) and mirrored by the plugin for permission gating.

import fs from "node:fs"
import path from "node:path"
import { matchUrlPattern } from "./urlmatch.mjs"

export { matchUrlPattern }

export const REDACTED = "[REDACTED]"

export const DEFAULT_POLICY = {
  allowedOrigins: ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"],
  cdpAllowedEndpoints: ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*", "ws://localhost:*", "ws://127.0.0.1:*", "ws://[::1]:*"],
  allowJsProbes: false,
  allowedPaths: [],
  redaction: {
    enabled: true,
    headerNames: [
      "authorization",
      "cookie",
      "set-cookie",
      "proxy-authorization",
      "x-api-key",
      "x-auth-token",
      "x-amz-security-token",
      "api-key",
      "x-csrf-token",
    ],
    keyPatterns: ["password", "passwd", "pwd", "secret", "token", "api[_-]?key", "apikey", "auth", "session", "jwt", "bearer", "credential", "private[_-]?key", "client[_-]?secret"],
    maxStringLength: 4000,
    maxTotalBytes: 262144,
    entropyHeuristic: false,
    allowAttachRawTrace: false,
  },
  timeouts: { step: 15000, navigate: 30000, harness: 240000 },
  retention: { maxRuns: 20, maxAuditBytes: 5 * 1024 * 1024 },
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

export function mergePolicy(partial = {}) {
  const base = DEFAULT_POLICY
  return {
    ...base,
    ...partial,
    allowedOrigins: partial.allowedOrigins ?? base.allowedOrigins,
    cdpAllowedEndpoints: partial.cdpAllowedEndpoints ?? base.cdpAllowedEndpoints,
    allowedPaths: [...(base.allowedPaths ?? []), ...(partial.allowedPaths ?? [])],
    redaction: { ...base.redaction, ...(partial.redaction ?? {}) },
    timeouts: { ...base.timeouts, ...(partial.timeouts ?? {}) },
    retention: { ...base.retention, ...(partial.retention ?? {}) },
  }
}

// --- origin / endpoint matching ---------------------------------------------

export function isUrlAllowed(rawUrl, policy) {
  return (policy.allowedOrigins ?? []).some((p) => matchUrlPattern(p, rawUrl))
}

export function isEndpointAllowed(endpoint, policy) {
  if (/^wss?:\/\//i.test(endpoint)) return (policy.cdpAllowedEndpoints ?? []).some((p) => matchUrlPattern(p, endpoint))
  return (policy.cdpAllowedEndpoints ?? []).some((p) => matchUrlPattern(p, endpoint))
}

// --- filesystem sandbox ------------------------------------------------------

const CASE_INSENSITIVE_FS = process.platform === "win32"

export function isPathAllowed(target, roots) {
  if (!target) return true
  const abs = normPath(path.resolve(target))
  return roots.some((root) => {
    const rel = path.relative(normPath(path.resolve(root)), abs)
    // Empty rel = the target IS the root; a `..`-prefixed or absolute rel
    // (different drive on Windows) means it escapes the root.
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  })
}

const normPath = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p)

// --- redaction ---------------------------------------------------------------

const VALUE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
]

const SENSITIVE_QUERY = /^(access_?token|token|api_?key|apikey|auth|authorization|password|passwd|pwd|secret|session|jwt|code|id_?token)$/i

function redactString(value, policy) {
  let out = String(value)
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

function shouldRedactKey(key, policy) {
  const names = policy.redaction.headerNames ?? []
  if (names.some((n) => n.toLowerCase() === String(key).toLowerCase())) return true
  const patterns = policy.redaction.keyPatterns ?? []
  return patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(String(key))
    } catch {
      return String(key).toLowerCase().includes(String(p).toLowerCase())
    }
  })
}

function looksHighEntropy(value) {
  if (typeof value !== "string" || value.length < 32) return false
  if (/[://\s]/.test(value)) return false
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[/_+= -]/].filter((re) => re.test(value)).length
  return classes >= 3
}

export function redactValue(value, policy, key = "") {
  if (!policy?.redaction?.enabled) return value
  if (value == null) return value
  if (typeof value === "string") {
    if (policy.redaction.entropyHeuristic && looksHighEntropy(value)) return REDACTED
    return redactString(value, policy)
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, policy))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // Composite values under a sensitive key (e.g. the storage preset's
      // `sessionStorage` tree) are recursed into rather than blacklisted, so
      // their inner sensitive keys are still masked but the rest stays
      // readable. Scalars are replaced outright.
      if (shouldRedactKey(k, policy) && !isPlainObject(v) && !Array.isArray(v)) out[k] = REDACTED
      else out[k] = redactValue(v, policy, k)
    }
    return out
  }
  return value
}

export function redactUrl(rawUrl, policy) {
  if (!policy?.redaction?.enabled || typeof rawUrl !== "string") return rawUrl
  let redacted = redactString(rawUrl, policy)
  try {
    const u = new URL(rawUrl)
    let changed = false
    for (const [k] of u.searchParams) {
      if (SENSITIVE_QUERY.test(k)) {
        u.searchParams.set(k, REDACTED)
        changed = true
      }
    }
    if (changed) redacted = u.toString()
  } catch {
    /* not a url */
  }
  return redacted
}

// --- size caps ---------------------------------------------------------------

export function limitValue(value, maxBytes) {
  const limit = maxBytes ?? DEFAULT_POLICY.redaction.maxTotalBytes
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    return value
  }
  if (json == null || Buffer.byteLength(json, "utf8") <= limit) return value
  const clone = JSON.parse(json)
  const slim = (v) => {
    if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50).map(slim), `…[+${v.length - 50} more]`] : v.map(slim)
    if (isPlainObject(v)) {
      const o = {}
      for (const [k, val] of Object.entries(v)) o[k] = typeof val === "string" && val.length > 500 ? `${val.slice(0, 500)}…[truncated]` : slim(val)
      return o
    }
    return v
  }
  return { truncated: true, note: `output exceeded ${limit} bytes and was trimmed`, value: slim(clone) }
}

// --- audit -------------------------------------------------------------------

export function createAuditor(auditFile, policy) {
  if (!auditFile) return () => {}
  const redact = (entry) => (policy?.redaction?.enabled ? redactValue(entry, policy) : entry)
  return (entry) => {
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true })
      fs.appendFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...redact(entry) })}\n`, "utf8")
    } catch {
      /* never fail the run because of audit */
    }
  }
}

export function inspectText(text) {
  return text
}

// --- artifact retention --------------------------------------------------------
// Keep `.gui-doctor` bounded: drop run dirs beyond `retention.maxRuns` (oldest
// first) and halve audit.log once it exceeds `retention.maxAuditBytes`.
export function pruneArtifacts(artifactsDir, retention) {
  const maxRuns = retention?.maxRuns
  try {
    const runsDir = path.join(artifactsDir, "runs")
    if (Number.isFinite(maxRuns) && maxRuns > 0 && fs.existsSync(runsDir)) {
      const entries = fs
        .readdirSync(runsDir)
        .map((name) => {
          const full = path.join(runsDir, name)
          return { name, full, mtime: fs.statSync(full).mtimeMs }
        })
        .sort((a, b) => a.mtime - b.mtime)
      for (const e of entries.slice(0, Math.max(0, entries.length - maxRuns))) {
        fs.rmSync(e.full, { recursive: true, force: true })
      }
    }
  } catch {
    /* never fail a run because of retention */
  }
  const maxAuditBytes = retention?.maxAuditBytes
  try {
    const audit = path.join(artifactsDir, "audit.log")
    if (Number.isFinite(maxAuditBytes) && maxAuditBytes > 0 && fs.existsSync(audit) && fs.statSync(audit).size > maxAuditBytes) {
      const text = fs.readFileSync(audit, "utf8")
      // Halve, but resume at a line boundary so a JSON entry is never split.
      const mid = Math.floor(text.length / 2)
      const nl = text.indexOf("\n", mid)
      const tail = nl === -1 ? "" : text.slice(nl + 1)
      fs.writeFileSync(audit, tail, "utf8")
    }
  } catch {
    /* ignore */
  }
}
